// quota_brake.mjs — 额度硬闸（authoritative brake）
//
// 目标：5 小时窗口 / 周窗口，任一 usedPercent >= 阈值 → 立刻把"正在生成的那个
//       codex.exe app-server"杀掉，让当前回合立即停止，不再继续烧额度。
//
// 为什么不用点"停止"按钮：UI 自动化靠截图/形状识别，布局一变就找不到按钮，
// 而且会在超阈值期间反复空转重试。杀掉正在写日志的 app-server 是唯一无歧义的刹车：
// 进程没了 → SSE 流断 → 回合结束；线程本身持久化在 SQLite 里，可 `codex resume` 继续。
//
// 依赖：Node >= 22.5（用到内置 node:sqlite），只用本机已登录的 Codex，不需要任何 API key。
// 只读额度：app-server 的 account/rateLimits/read（不是模型请求，不消耗额度）
//
// 用法：
//   node quota_brake.mjs --once --dry-run --json     # 只看判定，不动手
//   node quota_brake.mjs --once --json               # 跑一轮，超阈值就杀
//   node quota_brake.mjs                             # 常驻守护
//   node quota_brake.mjs --fake-percent 95 --fake-active 1234 --dry-run --once --json
// 参数：--threshold-5h N --threshold-weekly N --poll N --max-kills N --kill-cooldown N
//       --dry-run --once --json --fake-percent N --fake-active PID[,PID] --codex-bin PATH --config PATH

import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, mkdirSync, appendFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveCodexBin, readQuotaOnce } from './lib/quota.mjs';
// 活跃检测自己实现：desktop_activity.mjs 的 45s 窗口会把"刚被 resume / MCP 刷新"
// 的空闲线程误判成正在生成（实测：某空闲线程 74 秒只写了 5 行，
// 其中最近 30 秒仅 1 行，仍被判 active）。这里改成"行数增量 + 二次采样确认"。

const HERE = dirname(fileURLToPath(import.meta.url));
const ARGS = parseArgs(process.argv.slice(2));

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) { out._.push(a); continue; }
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) out[key] = true;
    else { out[key] = next; i++; }
  }
  return out;
}

const DEFAULTS = {
  threshold5h: 85,
  thresholdWeekly: 92,
  warnAt: 80,             // 软预警：到这条线先提醒一次，给用户收尾的机会（0 = 关闭）
  pollSeconds: 60,        // 正常节奏
  hotPollSeconds: 10,     // 超阈值 / 距阈值 5 点内
  killCooldownSec: 30,    // 同一 pid 两次 kill 的最小间隔
  killWindowSec: 600,     // 计数窗口：10 分钟内最多杀 maxKills 次（不是"一辈子"）
  maxKills: 20,           // 每个窗口内最多杀几次（与 30 秒冷却一起限制，正常情况下够用）
  maxKillsPerPid: 2,
};

const CFG_PATH = ARGS.config ? resolve(String(ARGS.config)) : join(HERE, 'config.json');
let fileCfg = {};
if (existsSync(CFG_PATH)) {
  try { fileCfg = JSON.parse(readFileSync(CFG_PATH, 'utf8').replace(/^\uFEFF/, '')); } catch (e) {
    console.error('ERROR: 配置文件不是合法 JSON: ' + CFG_PATH + ' — ' + e.message);
    process.exit(2);
  }
}

const cfg = {
  ...DEFAULTS,
  threshold5h: Number(fileCfg.threshold5h ?? DEFAULTS.threshold5h),
  thresholdWeekly: Number(fileCfg.thresholdWeekly ?? DEFAULTS.thresholdWeekly),
  warnAt: Number(fileCfg.warnAt ?? DEFAULTS.warnAt),
  killWindowSec: Number(fileCfg.brakeKillWindowSec ?? DEFAULTS.killWindowSec),
  ...(ARGS['threshold-5h'] !== undefined ? { threshold5h: Number(ARGS['threshold-5h']) } : {}),
  ...(ARGS['threshold-weekly'] !== undefined ? { thresholdWeekly: Number(ARGS['threshold-weekly']) } : {}),
  ...(ARGS.poll !== undefined ? { pollSeconds: Number(ARGS.poll) } : {}),
  ...(ARGS['max-kills'] !== undefined ? { maxKills: Number(ARGS['max-kills']) } : {}),
  ...(ARGS['kill-cooldown'] !== undefined ? { killCooldownSec: Number(ARGS['kill-cooldown']) } : {}),
  ...(ARGS['codex-bin'] !== undefined ? { codexBin: String(ARGS['codex-bin']) } : {}),
  dryRun: !!ARGS['dry-run'],
  json: !!ARGS.json,
};

const STATE_DIR = join(HERE, '.state');
mkdirSync(STATE_DIR, { recursive: true });
const STATE_PATH = (ARGS.once || cfg.dryRun)
  ? join(STATE_DIR, 'brake-state.scratch.json')   // 单次/试运行不许改动常驻守护的回合计数
  : join(STATE_DIR, 'brake-state.json');
const LOG_PATH = join(STATE_DIR, 'brake.log');
const LOCK_PATH = join(STATE_DIR, 'brake.lock');

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  if (cfg.json) console.error(line); else console.log(line);
  try {
    if (existsSync(LOG_PATH) && statSync(LOG_PATH).size > 8 * 1024 * 1024) writeFileSync(LOG_PATH, '');
    appendFileSync(LOG_PATH, line + '\n');
  } catch { /* ignore */ }
}
const jout = (o) => { if (cfg.json) console.log(JSON.stringify(o)); };

function pidAlive(pid) { try { process.kill(pid, 0); return true; } catch { return false; } }

/** 单实例锁：开机自启 + 手动启动不会变成两个刹车互相抢。 */
function acquireLock() {
  try {
    const raw = readFileSync(LOCK_PATH, 'utf8').trim();
    const j = raw ? JSON.parse(raw) : null;
    if (j && j.pid && j.pid !== process.pid && pidAlive(j.pid)) return false;
  } catch { /* no/corrupt lock */ }
  try { writeFileSync(LOCK_PATH, JSON.stringify({ pid: process.pid, at: Date.now() })); } catch { /* ignore */ }
  return true;
}
function releaseLock() {
  try {
    const j = JSON.parse(readFileSync(LOCK_PATH, 'utf8'));
    if (j && j.pid === process.pid) writeFileSync(LOCK_PATH, '');
  } catch { /* ignore */ }
}

/** 桌面气泡通知（同目录的 notify.ps1；不阻塞主循环）。 */
function notify(title, body) {
  if (cfg.dryRun) return;
  try {
    const sp = join(HERE, 'notify.ps1');
    if (!existsSync(sp)) return;
    const p = spawn('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', sp, '-Title', title, '-Body', body],
      { windowsHide: true, detached: true, stdio: 'ignore' });
    p.unref();
    log('notified: ' + title);
  } catch { /* ignore */ }
}

// ---------------------------------------------------------------- quota read
// app-server 客户端与窗口解析在 lib/quota.mjs 里（发送模块也用同一份）。
async function readQuota() {
  if (ARGS['fake-percent'] !== undefined) {
    const pct = Number(ARGS['fake-percent']);
    const wk = ARGS['fake-weekly'] !== undefined ? Number(ARGS['fake-weekly']) : Math.min(pct, 40);
    return {
      ok: true, fake: true,
      windows: [
        { label: '5h', usedPercent: pct, resetsAt: null, windowMins: 300 },
        { label: 'weekly', usedPercent: wk, resetsAt: null, windowMins: 10080 },
      ],
    };
  }
  const exe = resolveCodexBin({ explicit: cfg.codexBin, log });
  return readQuotaOnce({ exe, clientName: 'quota-brake' });
}

// ---------------------------------------------------------------- liveness (desktop app)
// 桌面 App 的 app-server 把每个回合的 trace 写进 ~/.codex/logs_<n>.sqlite:
// 生成中同一个 thread 每 0~13 秒落一行；回合结束后该 thread 静默。
// 判据：最近 30 秒 >= 2 行 + 最新一行在 20 秒内 + 二次采样仍在增长。
function resolveLogsDb(home = process.env.USERPROFILE) {
  const dir = join(home || '', '.codex');
  let best = null;
  try {
    for (const name of readdirSync(dir)) {
      const m = name.match(/^logs_(\d+)\.sqlite$/);
      if (!m) continue;
      const n = parseInt(m[1], 10);
      if (!best || n > best.n) best = { n, path: join(dir, name) };
    }
  } catch { /* ignore */ }
  return best ? best.path : join(dir, 'logs_2.sqlite');
}

let _db = null, _dbPath = null;

async function probeActivity({ lookbackSec = 300, win30 = 30, win8 = 8 } = {}) {
  const dbPath = resolveLogsDb();
  try {
    if (!_db || _dbPath !== dbPath) {
      const { DatabaseSync } = await import('node:sqlite');
      _db = new DatabaseSync(dbPath, { readOnly: true });
      _dbPath = dbPath;
    }
    const now = Math.floor(Date.now() / 1000);
    const rows = _db.prepare(
      `select thread_id as tid,
              max(ts) as lastTs,
              sum(case when ts >= ? then 1 else 0 end) as n30,
              sum(case when ts >= ? then 1 else 0 end) as n8,
              count(*) as n
         from logs
        where ts >= ? and thread_id is not null and thread_id <> ''
        group by thread_id
        order by lastTs desc
        limit 30`
    ).all(now - win30, now - win8, now - lookbackSec);
    const out = [];
    for (const r of rows) {
      let pid = null;
      try {
        const p = _db.prepare('select process_uuid from logs where thread_id = ? order by id desc limit 1').get(r.tid);
        const m = p && String(p.process_uuid || '').match(/pid:(\d+)/);
        if (m) pid = parseInt(m[1], 10);
      } catch { /* ignore */ }
      out.push({ threadId: r.tid, pid, lastTs: r.lastTs, n30: r.n30, n8: r.n8, n: r.n, ageMs: (now - r.lastTs) * 1000 });
    }
    return { ok: true, dbPath, rows: out };
  } catch (e) {
    _db = null; _dbPath = null;
    return { ok: false, error: e.message, rows: [] };
  }
}

/** 只把"真的在生成"的线程算进来：30 秒内 >= 2 行，最新一行 20 秒内。 */
export function pickGenerating(rows, { nowMs = Date.now(), maxAgeMs = 20000, minRows30 = 2 } = {}) {
  return (rows || [])
    .filter((r) => r && r.pid && (nowMs - r.lastTs * 1000) <= maxAgeMs && (r.n30 || 0) >= minRows30)
    .map((r) => ({ ...r, ageMs: nowMs - r.lastTs * 1000 }));
}

// ---------------------------------------------------------------- liveness (CLI / exec)
// `codex exec` 不写 thread_id 日志行（2026-11-20 实测：120 秒内 0 行带 thread_id），
// 所以 CLI 回合只能按进程看：名字 codex.exe 且命令行带 exec，并用 6 秒 CPU 增量确认。
function psJson(script, timeoutMs = 15000) {
  return new Promise((res) => {
    const p = spawn('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true });
    let out = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', () => {});
    const to = setTimeout(() => { try { p.kill(); } catch {} res(null); }, timeoutMs);
    p.on('close', () => {
      clearTimeout(to);
      const s = out.trim();
      if (!s) return res([]);
      try { const v = JSON.parse(s); return res(Array.isArray(v) ? v : [v]); } catch { return res(null); }
    });
    p.on('error', () => { clearTimeout(to); res(null); });
  });
}

async function probeCli() {
  const rows = await psJson(
    "Get-CimInstance Win32_Process -Filter \"Name='codex.exe'\" | " +
    "Where-Object { $_.CommandLine -match '\\sexec\\s' } | " +
    "ForEach-Object { $p = Get-Process -Id $_.ProcessId -ErrorAction SilentlyContinue; " +
    "if ($p) { [pscustomobject]@{ pid = $_.ProcessId; cpu = [double]$p.CPU } } } | ConvertTo-Json -Compress"
  );
  return (rows || []).filter((r) => r && r.pid);
}

/** 一批 pid 的累计 CPU 秒数（用来做"没新日志但还在算"的兜底确认）。 */
async function probeCpu(pids) {
  const list = [...new Set((pids || []).filter((x) => Number.isInteger(x) && x > 0))];
  if (!list.length) return {};
  const rows = await psJson(
    'Get-Process -Id ' + list.join(',') + ' -ErrorAction SilentlyContinue | ' +
    'ForEach-Object { [pscustomobject]@{ pid = $_.Id; cpu = [double]$_.CPU } } | ConvertTo-Json -Compress'
  );
  const map = {};
  for (const r of (rows || [])) if (r && r.pid) map[r.pid] = Number(r.cpu) || 0;
  return map;
}

// ---------------------------------------------------------------- decision (pure)
export function killDecision({ over, active, now, killTimes = [], killTimesByPid = {}, deadPids = {}, maxKills, cooldownMs, windowMs = 600000, maxKillsPerPid = 2 }) {
  if (!over) return { act: false, reason: 'under-threshold', targets: [] };
  if (!active || !active.length) return { act: false, reason: 'nothing-generating', targets: [] };
  const recent = killTimes.filter((t) => now - t < windowMs);
  if (recent.length >= maxKills) return { act: false, reason: 'kill-cap (' + recent.length + '/' + maxKills + ' in ' + Math.round(windowMs / 60000) + 'min)', targets: [] };
  const seen = new Set();
  const targets = [];
  for (const t of active) {
    if (!t.pid || seen.has(t.pid)) continue;          // 同一 app-server 上两个线程同时跑 → 只杀一次
    if (deadPids[t.pid]) continue;                    // 这 pid 自己已经没了，别再追
    const perPid = (killTimesByPid[t.pid] || []).filter((x) => now - x < windowMs).length;
    if (perPid >= maxKillsPerPid) continue;
    seen.add(t.pid);
    targets.push(t);
  }
  if (!targets.length) return { act: false, reason: 'no-killable-target', targets: [] };
  if (killTimes.length) {
    const last = Math.max(...killTimes);
    if (now - last < cooldownMs) {
      return { act: false, reason: 'cooldown (' + Math.round((now - last) / 1000) + 's < ' + Math.round(cooldownMs / 1000) + 's)', targets };
    }
  }
  return { act: true, reason: 'over-threshold + generating', targets };
}

// ---------------------------------------------------------------- kill
function imageName(pid) {
  return new Promise((res) => {
    const p = spawn('tasklist', ['/FI', 'PID eq ' + pid, '/FO', 'CSV', '/NH'], { windowsHide: true });
    let out = '';
    p.stdout.on('data', (d) => (out += d));
    p.on('close', () => { const m = out.match(/"([^"]+\.exe)"/i); res(m ? m[1].toLowerCase() : null); });
    p.on('error', () => res(null));
  });
}

/** tasklist 对刚退出/刚启动的 pid 可能拿不到名字，用 Get-Process 兜底一次。 */
async function imageNamePs(pid) {
  const rows = await psJson("$p = Get-Process -Id " + Number(pid) + " -ErrorAction SilentlyContinue; if ($p) { $p.ProcessName } else { '' }");
  const s = Array.isArray(rows) ? String(rows[0] || '') : String(rows || '');
  const t = s.trim().toLowerCase();
  if (!t) return null;
  return t.endsWith('.exe') ? t : t + '.exe';
}

async function killPid(pid, dryRun) {
  let img = await imageName(pid);
  if (!img) {
    // 最常见的情况：探活和动手之间 app-server 已经被 App 换掉了 → 回合本来就停了
    if (!pidAlive(pid)) return { ok: false, noop: true, why: 'pid already exited (nothing left to stop)' };
    img = await imageNamePs(pid);
  }
  if (img !== 'codex.exe') return { ok: false, why: 'refusing to kill ' + (img || 'pid ' + pid) };
  if (dryRun) return { ok: true, dryRun: true, why: 'would kill codex.exe pid ' + pid };
  return new Promise((res) => {
    const p = spawn('taskkill', ['/PID', String(pid), '/F'], { windowsHide: true });
    const chunks = [];
    p.stdout.on('data', (d) => chunks.push(d));
    p.stderr.on('data', (d) => chunks.push(d));
    p.on('close', (code) => {
      const raw = Buffer.concat(chunks);
      let text = raw.toString('utf8');
      try { text = new TextDecoder('gbk').decode(raw); } catch { /* keep utf8 */ }   // taskkill 输出是 GBK
      if (code === 0) return res({ ok: true, why: 'killed' });
      if (!pidAlive(pid)) return res({ ok: true, why: 'already gone' });              // 目标已自己退出，不算失败
      res({ ok: false, why: 'taskkill exit ' + code + ': ' + text.trim().slice(0, 160) });
    });
    p.on('error', (e) => res({ ok: false, why: e.message }));
  });
}

// ---------------------------------------------------------------- state
function loadState() {
  try {
    const raw = readFileSync(STATE_PATH, 'utf8').replace(/^\uFEFF/, '');   // BOM 会让 JSON.parse 直接抛
    const s = JSON.parse(raw);
    // 清理旧版字段，避免状态文件里同时存在两套计数（kills/killsByPid 是 2026-11-20 之前的）
    delete s.kills; delete s.killsByPid;
    return s;
  } catch { return { killTimes: [], killTimesByPid: {}, deadPids: {}, episodeStartedAt: null }; }
}
function saveState(s) { try { writeFileSync(STATE_PATH, JSON.stringify(s, null, 2)); } catch {} }

// ---------------------------------------------------------------- one tick
// 阈值热更新：改配置文件不用重启守护（改坏了就保留旧值并记一行）
let _cfgMtime = 0;
function reloadConfig() {
  try {
    if (!existsSync(CFG_PATH)) return;   // 没配置文件就用默认值，不用每拍喊一次
    const st = statSync(CFG_PATH);
    if (st.mtimeMs === _cfgMtime) return;
    _cfgMtime = st.mtimeMs;
    const j = JSON.parse(readFileSync(CFG_PATH, 'utf8').replace(/^\uFEFF/, ''));
    const before = cfg.threshold5h + '/' + cfg.thresholdWeekly + '/k' + cfg.maxKills;
    if (ARGS['threshold-5h'] === undefined && Number.isFinite(Number(j.threshold5h))) cfg.threshold5h = Number(j.threshold5h);
    if (ARGS['threshold-weekly'] === undefined && Number.isFinite(Number(j.thresholdWeekly))) cfg.thresholdWeekly = Number(j.thresholdWeekly);
    if (ARGS['max-kills'] === undefined && Number(j.brakeMaxKills) > 0) cfg.maxKills = Number(j.brakeMaxKills);
    if (ARGS['kill-cooldown'] === undefined && Number(j.brakeKillCooldownSec) >= 0) cfg.killCooldownSec = Number(j.brakeKillCooldownSec);
    if (ARGS['kill-window'] === undefined && Number(j.brakeKillWindowSec) >= 60) cfg.killWindowSec = Number(j.brakeKillWindowSec);
    if (Number.isFinite(Number(j.warnAt)) && Number(j.warnAt) >= 0) cfg.warnAt = Number(j.warnAt);
    if (j.brakeEnabled === false) cfg.enabled = false; else cfg.enabled = true;
    const after = cfg.threshold5h + '/' + cfg.thresholdWeekly + '/k' + cfg.maxKills;
    if (before !== after) log('config reloaded: 5h>=' + cfg.threshold5h + '% weekly>=' + cfg.thresholdWeekly + '% maxKills=' + cfg.maxKills);
  } catch (e) {
    log('config reload skipped (keeping previous): ' + ((e && e.message) || e));
  }
}

async function tick(state) {
  reloadConfig();
  if (cfg.enabled === false) {
    if (state.disabledLogged !== true) { log('brakeEnabled=false：刹车暂时停用（不再杀任何进程）'); state.disabledLogged = true; saveState(state); }
    return { ok: true, over: false, nextDelayMs: cfg.hotPollSeconds * 1000 };   // 停用期间也保持 15 秒，改回 true 能立刻生效
  }
  if (state.disabledLogged === true) { log('brakeEnabled=true：刹车已恢复'); }
  state.disabledLogged = false;
  let q = await readQuota();
  if (!q.ok) {
    // 后端读取偶发超时（实测 15:31、15:48 各一次）。一次失败就跳过整拍会留下保护空档，
    // 所以先 3 秒后重试一次；仍失败才放弃这一拍（不拿旧快照动手，避免窗口重置瞬间误杀）。
    log('quota read failed (' + q.error + '), retry once in 3s');
    await new Promise((r) => setTimeout(r, 3000));
    q = await readQuota();
    state.readFailures = (state.readFailures || 0) + 1;
  }
  if (!q.ok) {
    log('quota read failed twice: ' + q.error);
    jout({ ok: false, error: q.error });
    return { ok: false, over: false, nextDelayMs: cfg.hotPollSeconds * 1000 };
  }
  const thr = { '5h': cfg.threshold5h, weekly: cfg.thresholdWeekly };
  const windows = q.windows.map((w) => ({ ...w, threshold: thr[w.label] ?? cfg.threshold5h, over: w.usedPercent >= (thr[w.label] ?? cfg.threshold5h) }));
  const over = windows.some((w) => w.over);
  const near = windows.some((w) => !w.over && w.usedPercent >= (w.threshold - 5));

  // 软预警：到 warnAt 先提醒一次（同一窗口周期只提醒一次），让人有机会体面收尾，
  // 而不是等到阈值被硬停。窗口重置后（resetsAt 变了）会重新提醒。
  if (cfg.warnAt > 0 && !over) {
    const warned = state.warnedFor || {};
    const toWarn = windows.filter((w) => !w.over
      && w.usedPercent >= Math.min(cfg.warnAt, w.threshold - 1)
      && warned[w.label] !== w.resetsAt);
    if (toWarn.length) {
      for (const w of toWarn) warned[w.label] = w.resetsAt;
      state.warnedFor = warned;
      log('warn: ' + toWarn.map((w) => w.label + '=' + w.usedPercent + '% (阈值 ' + w.threshold + '%)').join(', '));
      notify('Codex 额度预警',
        toWarn.map((w) => w.label + ' 已用 ' + w.usedPercent + '%（阈值 ' + w.threshold + '%）').join('；')
        + '。再往上就要被自动停了，建议现在收尾。');
    }
  }

  let active = [];
  let confirmed = null;
  if (ARGS['fake-active'] !== undefined) {
    const pids = String(ARGS['fake-active']).split(',').map((x) => parseInt(x.trim(), 10)).filter(Boolean);
    active = pids.map((pid) => ({ threadId: 'fake', pid, ageMs: 0, lastTs: Math.floor(Date.now() / 1000) }));
  } else {
    const a = await probeActivity();
    if (!a.ok) log('activity read failed: ' + a.error);
    let cands = pickGenerating(a.rows);
    let cli = await probeCli();
    const asCli = (x) => ({ threadId: 'cli:' + x.pid, pid: x.pid, ageMs: 0, cli: true, cpu: x.cpu });
    if (over && (cands.length || cli.length)) {
      // 二次采样确认。窗口必须是 18 秒：实测生成中的回合两行之间最长可隔 ~13 秒
      // （工具调用里在跑 Start-Sleep 时日志是静默的），6 秒窗口会把真回合判成空闲。
      // 双通道确认：日志行继续长，或该 app-server 的 CPU 在涨（超长推理会长时间不落行）。
      const pids = [...new Set([...cands.map((c) => c.pid), ...cli.map((x) => x.pid)].filter(Boolean))];
      const cpuBefore = await probeCpu(pids);
      await new Promise((r) => setTimeout(r, 18000));
      const b = await probeActivity();
      const after = new Map((b.rows || []).map((x) => [x.threadId, x]));
      const cpuAfter = await probeCpu(pids);
      const cpuGrew = (pid) => pid && (cpuAfter[pid] ?? 0) - (cpuBefore[pid] ?? 0) >= 0.3;
      const kept = [];
      for (const c of cands) {
        const n = after.get(c.threadId);
        if (!n) continue;
        const grew = n.lastTs > c.lastTs || (n.n30 || 0) > (c.n30 || 0);
        const fresh = (Date.now() - n.lastTs * 1000) <= 20000;
        // 桌面回合只认日志增量：app-server 空闲时也会因 MCP/工具子进程吃点 CPU，
        // 用 CPU 当桌面判据会误杀（CLI 没有日志行，才用 CPU）。
        if (grew && fresh) kept.push({ ...c, pid: n.pid || c.pid, lastTs: n.lastTs, ageMs: Date.now() - n.lastTs * 1000, via: 'log' });
      }
      const cliKept = cli.filter((x) => cpuGrew(x.pid));
      confirmed = {
        desktopBefore: cands.length, desktopAfter: kept.length,
        cliBefore: cli.length, cliAfter: cliKept.length,
        cpuBefore, cpuAfter, at: new Date().toISOString(),
      };
      if ((cands.length || cli.length) && !(kept.length || cliKept.length)) {
        log('generation not confirmed on re-sample (no new rows, no CPU) -> no action');
      }
      active = [...kept, ...cliKept.map(asCli)];
    } else {
      active = [...cands, ...cli.map(asCli)];
    }
  }

  const now = Date.now();
  // 滑动窗口计数：24 小时都在阈值之上时，刹车仍要能工作（旧的"每回合最多 6 次"会在
  // 用户反复尝试 6 次后彻底罢工，反而没人守）
  state.killTimes = (state.killTimes || []).filter((t) => now - t < 3600000);
  for (const k of Object.keys(state.killTimesByPid || {})) {
    state.killTimesByPid[k] = state.killTimesByPid[k].filter((t) => now - t < 3600000);
    if (!state.killTimesByPid[k].length) delete state.killTimesByPid[k];
  }
  for (const k of Object.keys(state.deadPids || {})) {
    if (now - state.deadPids[k] > 3600000) delete state.deadPids[k];
  }
  if (over && !state.episodeStartedAt) {
    state.episodeStartedAt = now;
    log('episode start (over: ' + windows.filter((w) => w.over).map((w) => w.label + '=' + w.usedPercent + '%').join(', ') + ')');
  }
  if (!over && state.episodeStartedAt) {
    log('episode end (back under threshold)');
    state.episodeStartedAt = null;
  }

  const d = killDecision({
    over, active, now,
    killTimes: state.killTimes,
    killTimesByPid: state.killTimesByPid || {},
    deadPids: state.deadPids || {},
    maxKills: cfg.maxKills,
    cooldownMs: cfg.killCooldownSec * 1000,
    windowMs: cfg.killWindowSec * 1000,
    maxKillsPerPid: DEFAULTS.maxKillsPerPid,
  });

  const report = {
    ok: true,
    dryRun: cfg.dryRun,
    over,
    verdict: over ? 'PAUSE' : 'OK',
    windows: windows.map((w) => ({ label: w.label, usedPercent: w.usedPercent, threshold: w.threshold, over: w.over, resetsAt: w.resetsAt })),
    active: active.map((t) => ({ threadId: String(t.threadId).slice(0, 8), pid: t.pid, ageSec: Math.round((t.ageMs || 0) / 1000) })),
    decision: { act: d.act, reason: d.reason, targets: d.targets.map((t) => t.pid) },
    confirmed,
    killed: [],
  };

  if (d.act) {
    for (const t of d.targets) {
      const r = await killPid(t.pid, cfg.dryRun);
      report.killed.push({ pid: t.pid, ...r });
      if (r.ok && !cfg.dryRun) {
        state.killTimes = [...(state.killTimes || []), now];
        state.lastKillAt = now;
        const kp = { ...(state.killTimesByPid || {}) };
        kp[t.pid] = [...(kp[t.pid] || []), now];
        state.killTimesByPid = kp;
      }
      if (r.noop) {
        // pid 已经自己没了：回合本来就停了，把该 pid 拉黑一小时，别在它身上反复重试
        state.deadPids = { ...(state.deadPids || {}), [t.pid]: now };
      }
      log((cfg.dryRun ? 'DRY-RUN would kill ' : 'HARD STOP ') + 'pid ' + t.pid + ' (thread ' + String(t.threadId).slice(0, 8) + ') -> ' + r.why);
    }
    const killedOk = report.killed.filter((k) => k.ok);
    if (killedOk.length && !cfg.dryRun) {
      const overText = windows.filter((w) => w.over).map((w) => w.label + ' ' + w.usedPercent + '%').join(' / ');
      notify('Codex 额度已到阈值，已暂停当前回合',
        overText + ' ≥ 阈值 ' + windows.filter((w) => w.over).map((w) => w.threshold + '%').join('/') +
        '；已停止生成进程 ' + killedOk.map((k) => k.pid).join(',') + '。窗口重置前继续发起的回合会被同样停掉。');
    }
  } else if (over) {
    if (state.lastReason !== d.reason) { log('over threshold, no action: ' + d.reason); state.lastReason = d.reason; }
    if (String(d.reason).startsWith('kill-cap') && (!state.capNotifiedAt || now - state.capNotifiedAt > 600000)) {
      state.capNotifiedAt = now;
      notify('额度刹车到达出手上限',
        '10 分钟内已停 ' + cfg.maxKills + ' 次，接下来这段时间不再自动停。如果还有回合在跑，请手动停一下。');
    }
  } else {
    state.lastReason = null;
    state.capNotifiedAt = 0;
  }

  // 心跳：第一拍和之后每 20 拍写一行，证明守护活着且读到了真实百分比
  state.ticks = (state.ticks || 0) + 1;
  saveState(state);
  jout(report);
  if (state.ticks === 1 || state.ticks % 20 === 0) {
    log('tick #' + state.ticks + ' ' + windows.map((w) => w.label + '=' + w.usedPercent + '%/' + w.threshold + '%').join(' ') +
      ' verdict=' + report.verdict + ' active=' + active.length + ' kills10m=' + (state.killTimes || []).length);
  }
  const delay = over || near ? cfg.hotPollSeconds * 1000 : cfg.pollSeconds * 1000;
  return { ok: true, over, near, nextDelayMs: delay, report };
}

// ---------------------------------------------------------------- main
async function main() {
  const state = loadState();
  // 手动 `--once` 常常只是想看一眼状态；不加 --yes 就绝不真杀，免得误停正在干的活
  if (ARGS.once && !ARGS.yes && !cfg.dryRun) {
    cfg.dryRun = true;
    log('--once 默认只判定不动作（安全）；要真的执行请加 --yes');
  }
  if (cfg.dryRun) log('--- dry-run: 不会真的杀进程 ---');
  log('quota-brake start (5h>=' + cfg.threshold5h + '%, weekly>=' + cfg.thresholdWeekly + '%, poll ' + cfg.pollSeconds + 's/' + cfg.hotPollSeconds + 's)');

  if (ARGS.once) {
    const r = await tick(state);
    process.exit(r.ok ? 0 : 1);
  }

  if (!acquireLock()) {
    log('another brake instance is running (lock ' + LOCK_PATH + '); exiting');
    process.exit(0);
  }
  process.on('exit', releaseLock);
  process.on('SIGTERM', () => { releaseLock(); process.exit(0); });

  let delay = cfg.pollSeconds * 1000;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    await new Promise((r) => setTimeout(r, delay));
    try {
      const r = await tick(state);
      delay = r.nextDelayMs || cfg.pollSeconds * 1000;
    } catch (e) {
      log('tick failed: ' + (e && e.stack || e));
      delay = cfg.pollSeconds * 1000;
    }
  }
}

const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isMain) {
  process.on('unhandledRejection', (e) => log('unhandledRejection (ignored): ' + (e && e.message || e)));
  process.on('SIGINT', () => { log('SIGINT, exit'); process.exit(0); });
  main();
}
