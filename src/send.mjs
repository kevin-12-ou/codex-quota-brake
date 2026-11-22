// send.mjs — 定时 / 等额度重置后再把消息投给 Codex 会话
//
// 为什么需要它：5 小时窗口撞满后，Codex 会拒绝新请求；可任务不能一直等下去。
// 这个工具用 Codex 原生的 `codex queue --thread <id> --message <text>` 投递
// （不需要 GUI、不需要点按钮、中文原样送达），支持三种触发方式：
//   --now           立刻发
//   --in 2h30m      相对时间
//   --at "2026-11-21 09:00:00"
//   --when-reset    读到额度窗口的重置时间，重置后再发（最省心的用法）
//
// 用法：
//   node send.mjs --list                                   # 列出最近的会话（标题 + id）
//   node send.mjs --thread <id|标题> --message "继续"        # 立刻发
//   node send.mjs --thread <id> --message "继续" --in 2h    # 定时
//   node send.mjs --thread <id> --message "继续" --when-reset
//   node send.mjs --status | --cancel
//
// 参数：--thread --message --now --in --at --when-reset --buffer 60 --threshold 85
//       --status --cancel --list --json --config PATH --codex-bin PATH

import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, mkdirSync, appendFileSync, unlinkSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveCodexBin, readQuotaOnce } from './lib/quota.mjs';

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

const STATE_DIR = join(HERE, '.state');
mkdirSync(STATE_DIR, { recursive: true });
const STATE_PATH = join(STATE_DIR, 'send-schedule.json');
const LOG_PATH = join(STATE_DIR, 'send.log');

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  if (ARGS.json) console.error(line); else console.log(line);
  try { appendFileSync(LOG_PATH, line + '\n'); } catch { /* ignore */ }
}
const jout = (o) => { if (ARGS.json) console.log(JSON.stringify(o)); };
const pidAlive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

function readState() { try { return JSON.parse(readFileSync(STATE_PATH, 'utf8').replace(/^\uFEFF/, '')); } catch { return null; } }
function writeState(o) { try { writeFileSync(STATE_PATH, JSON.stringify(o, null, 2)); } catch (e) { log('write state failed: ' + e.message); } }
function clearState() { try { unlinkSync(STATE_PATH); } catch { /* ignore */ } }

// ---------------------------------------------------------------- 时间解析
/** "90m" / "1h30m" / "45s" / "2h" → 毫秒 */
export function parseDuration(s) {
  const str = String(s).trim().toLowerCase();
  if (!str) return null;
  let total = 0, matched = false;
  const re = /(\d+(?:\.\d+)?)\s*(ms|s|m|h|d|秒|分|小时|天)/g;
  let m;
  while ((m = re.exec(str))) {
    matched = true;
    const n = parseFloat(m[1]);
    const unit = m[2];
    const mult = unit === 'ms' ? 1
      : unit === 's' || unit === '秒' ? 1000
      : unit === 'm' || unit === '分' ? 60000
      : unit === 'h' || unit === '小时' ? 3600000
      : 86400000;
    total += n * mult;
  }
  if (!matched) {
    const n = Number(str);
    return Number.isFinite(n) ? n : null;   // 纯数字按秒算
  }
  return total;
}

/** "2026-11-21 09:00[:00]" / ISO / epoch 秒 → 毫秒 */
export function parseWhen(s) {
  const str = String(s).trim();
  if (/^\d{10,}$/.test(str)) return Number(str) * 1000;          // epoch 秒
  const m = str.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/);
  if (m) return new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0)).getTime();
  const t = Date.parse(str);
  return Number.isFinite(t) ? t : null;
}

// ---------------------------------------------------------------- 投递（codex queue）
function deliver(thread, message, { resumeFirst = false } = {}) {
  const bin = ARGS['codex-bin'] ? String(ARGS['codex-bin']) : resolveCodexBin({ log });
  const attempt = (useResume) => new Promise((res) => {
    const argv = ['queue', '--thread', thread, '--message', message];
    if (useResume) argv.push('--resume');
    log('queue: ' + bin + ' queue --thread "' + thread + '" --message "' + message + '"' + (useResume ? ' --resume' : ''));
    let child;
    try { child = spawn(bin, argv, { shell: false, windowsHide: true }); }
    catch (e) { return res({ ok: false, error: e.message }); }
    let out = '', err = '', done = false;
    const finish = (r) => { if (!done) { done = true; res(r); } };
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('error', (e) => finish({ ok: false, error: e.message }));
    child.on('exit', (code) => {
      const text = (out + '\n' + err).trim().replace(/^codex\.exe\s*:\s*/i, '').replace(/\s+/g, ' ');
      if (code === 0) return finish({ ok: true });
      finish({ ok: false, error: text.slice(0, 300) || ('exit ' + code) });
    });
    setTimeout(() => { try { child.kill(); } catch { /* ignore */ } finish({ ok: false, error: 'timeout after 30s' }); }, 30000);
  });

  return (async () => {
    let r = resumeFirst ? await attempt(true) : await attempt(false);
    if (!r.ok && !resumeFirst) {
      log('plain queue failed (' + (r.error || '?') + '), retry with --resume');
      r = await attempt(true);
    }
    if (r.ok) log('delivered -> ' + thread); else log('delivery FAILED -> ' + thread + ' :: ' + (r.error || ''));
    return r;
  })();
}

// ---------------------------------------------------------------- 会话列表（只读 sqlite）
async function listThreads(limit = 12) {
  try {
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(join(process.env.USERPROFILE || '', '.codex', 'state_5.sqlite'), { readOnly: true });
    const rows = db.prepare('select id, title, updated_at from threads order by updated_at desc limit ?').all(limit);
    db.close();
    return rows.map((r) => ({
      id: r.id,
      title: (r.title || '(未命名)').slice(0, 60),
      updated: r.updated_at ? new Date(Number(r.updated_at) * 1000).toLocaleString('zh-CN') : '',
    }));
  } catch (e) {
    return [{ error: e.message }];
  }
}

// ---------------------------------------------------------------- 主流程
async function main() {
  if (ARGS.help) {
    console.log(`send.mjs — 把消息投给 Codex 会话（立刻 / 定时 / 等额度重置）

  node send.mjs --list
  node send.mjs --thread <id|标题> --message "继续"
  node send.mjs --thread <id> --message "继续" --in 2h30m
  node send.mjs --thread <id> --message "继续" --at "2026-11-21 09:00:00"
  node send.mjs --thread <id> --message "继续" --when-reset [--buffer 60] [--threshold 85]
  node send.mjs --status | --cancel

  --json 输出机器可读结果；--codex-bin 指定 codex.exe；--config 预留`);
    return 0;
  }

  if (ARGS.list) {
    const rows = await listThreads(Number(ARGS.limit) || 12);
    if (ARGS.json) { jout({ ok: true, threads: rows }); return 0; }
    console.log('最近的会话：');
    for (const r of rows) {
      if (r.error) { console.log('  ERROR: ' + r.error); continue; }
      console.log('  ' + r.id + '  ' + (r.updated || '') + '  ' + r.title);
    }
    return 0;
  }

  if (ARGS.status) {
    const st = readState();
    if (!st) { if (ARGS.json) jout({ ok: true, pending: false }); else console.log('没有待发送的任务'); return 0; }
    const remain = st.sendAt ? Math.max(0, Math.round(st.sendAt - Date.now() / 1000)) : 0;
    const running = st.pid ? pidAlive(st.pid) : false;
    if (ARGS.json) jout({ ok: true, pending: running && !st.done, state: st, remainingSec: remain });
    else {
      console.log('会话：  ' + st.thread);
      console.log('消息：  ' + st.message);
      console.log('发送于：' + (st.sendAt ? new Date(st.sendAt * 1000).toLocaleString('zh-CN') : '?'));
      console.log('状态：  ' + (st.done ? '已发送' : st.failed ? '失败：' + (st.error || '') : running ? '等待中（剩 ' + remain + ' 秒）' : '调度进程已退出'));
    }
    return 0;
  }

  if (ARGS.cancel) {
    const st = readState();
    if (!st) { if (ARGS.json) jout({ ok: true, cancelled: false }); else console.log('没有待发送的任务'); return 0; }
    let killed = false;
    if (st.pid && pidAlive(st.pid)) { try { process.kill(st.pid); killed = true; } catch { /* ignore */ } }
    clearState();
    if (ARGS.json) jout({ ok: true, cancelled: true, killed });
    else console.log(killed ? '已取消并停掉调度进程' : '已取消（调度进程本来就不在了）');
    return 0;
  }

  const thread = ARGS.thread ? String(ARGS.thread) : null;
  const message = ARGS.message ? String(ARGS.message) : null;
  if (!thread || !message) {
    console.error('缺少 --thread / --message。用 --help 看用法。');
    return 2;
  }

  // 立刻发
  if (ARGS.now || (!ARGS.in && !ARGS.at && !ARGS['when-reset'] && !ARGS.run)) {
    const r = await deliver(thread, message);
    if (ARGS.json) jout({ ok: r.ok, thread, message, error: r.error || null });
    return r.ok ? 0 : 1;
  }

  // 调度进程（内部模式）
  if (ARGS.run) {
    const atSec = Number(ARGS.at);
    if (!Number.isFinite(atSec)) { log('--run 需要 --at <epoch秒>'); return 2; }
    log('scheduler: "' + message + '" -> ' + thread + ' at ' + new Date(atSec * 1000).toLocaleString('zh-CN'));
    while (true) {
      const remain = atSec - Date.now() / 1000;
      if (remain <= 0) break;
      writeState({ thread, message, sendAt: atSec, remainingSec: Math.round(remain), pid: process.pid, updated: Date.now() });
      await new Promise((r) => setTimeout(r, Math.min(remain * 1000, 60000)));
    }
    const r = await deliver(thread, message);
    writeState({ thread, message, sendAt: atSec, done: r.ok, failed: !r.ok, error: r.ok ? null : r.error, pid: process.pid, updated: Date.now() });
    return r.ok ? 0 : 1;
  }

  // 计算目标时间
  let atMs = null;
  if (ARGS.in) {
    const d = parseDuration(ARGS.in);
    if (!d) { console.error('--in 格式不对，例如 90m / 2h30m / 45s'); return 2; }
    atMs = Date.now() + d;
  } else if (ARGS.at) {
    atMs = parseWhen(ARGS.at);
    if (!atMs) { console.error('--at 格式不对，例如 "2026-11-21 09:00:00"'); return 2; }
  } else if (ARGS['when-reset']) {
    const threshold = Number(ARGS.threshold ?? 85);
    const buffer = Number(ARGS.buffer ?? 60);
    const q = await readQuotaOnce({ clientName: 'quota-send' });
    if (!q.ok) { console.error('读额度失败：' + q.error); return 1; }
    const over = q.windows.filter((w) => w.usedPercent >= threshold && w.resetsAt);
    if (!over.length) {
      log('额度没到阈值（' + q.windows.map((w) => w.label + '=' + w.usedPercent + '%').join(' ') + '），直接发送');
      const r = await deliver(thread, message);
      if (ARGS.json) jout({ ok: r.ok, sentNow: true, error: r.error || null });
      return r.ok ? 0 : 1;
    }
    const next = over.sort((a, b) => a.resetsAt - b.resetsAt)[0];
    atMs = next.resetsAt * 1000 + buffer * 1000;
    log('等 ' + next.label + ' 窗口重置（' + new Date(next.resetsAt * 1000).toLocaleString('zh-CN') + '）+ ' + buffer + ' 秒');
  }

  if (!atMs || atMs <= Date.now()) { console.error('目标时间无效'); return 2; }
  const atSec = Math.floor(atMs / 1000);

  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), '--run', '--at', String(atSec),
    '--thread', thread, '--message', message], { detached: true, stdio: 'ignore', windowsHide: true });
  child.unref();
  writeState({ thread, message, sendAt: atSec, pid: child.pid, updated: Date.now(), pending: true });
  log('已排期：' + new Date(atMs).toLocaleString('zh-CN') + ' 发送 "' + message + '" -> ' + thread + '（调度 pid ' + child.pid + '）');
  if (ARGS.json) jout({ ok: true, scheduled: true, thread, message, sendAt: atSec, pid: child.pid });
  return 0;
}

const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isMain) {
  process.on('unhandledRejection', (e) => log('unhandledRejection: ' + ((e && e.message) || e)));
  main().then((code) => process.exit(code)).catch((e) => { console.error(e && e.stack || e); process.exit(1); });
}
