#!/usr/bin/env node
/**
 * fingerprint.mjs — 模型指纹 / 降智检测（模型是否被换掉或变差）
 *
 * Wraps the official detector (lmfpd / lm.ikale.io) so the tool suite can run a
 * detection with ONE click, fully locally (no browser):
 *
 *   Codex mode : generate the site's own random challenges -> ask the local Codex
 *                (server-side `codex exec`, same model the user actually uses) ->
 *                capture replies -> score locally with `lmfpd --input` ->
 *                archive the 3 test sessions -> verdict.
 *   Relay mode : point lmfpd straight at a relay API (baseurl+key+model); it
 *                generates challenges, queries the model and scores, all by itself.
 *
 * The scoring algorithm / reference bank is exactly the site's (bundled in lmfpd).
 * Nothing here re-implements or fakes the detector.
 *
 * No third-party deps. Node >= 22 (uses built-in fetch-free spawn only).
 *
 * Usage:
 *   node fingerprint.mjs --run --mode codex  [--json]
 *   node fingerprint.mjs --run --mode relay  [--json]
 *   node fingerprint.mjs --status [--json]
 *   node fingerprint.mjs --log [--days 30] [--json]
 *   flags: --count N --rounds N --retries N --model M --baseurl U --apikey K
 *          --api responses|chatcompletion|message --threshold N --config FILE
 */

import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, mkdirSync, appendFileSync, readdirSync, statSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import os from 'node:os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TMP = os.tmpdir();

// ----------------------------- args -----------------------------
function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') { out.help = true; continue; }
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const val = (i + 1 < argv.length && !argv[i + 1].startsWith('--')) ? argv[++i] : 'true';
      out[key] = val; continue;
    }
    out._.push(a);
  }
  return out;
}
const args = parseArgs(process.argv.slice(2));

// ----------------------------- config -----------------------------
const DEFAULTS = {
  count: 3,                 // samples per round (site default 3)
  rounds: 1,
  retries: 2,               // retry a failed sample this many extra times
  codexExpectedModel: 'gpt-6-astra', // family that gpt-6.1-sol should map to
  confidenceThreshold: 60,  // >= this (0-100) counts as "confident"
  relay: {
    baseurl: '', apikey: '', model: '', api: 'chatcompletion',
    image: false, timeoutSec: 120,
  },
  // daily auto-run (server reads this; engine only records it)
  dailyEnabled: false,
  dailyTime: '09:00',
};
const configPath = args.config ? resolve(args.config) : join(__dirname, 'fingerprint.config.json');
let fileCfg = {};
if (existsSync(configPath)) { try { fileCfg = JSON.parse(readFileSync(configPath, 'utf8')); } catch (e) { console.error('WARN bad config:', e.message); } }
const cfg = {
  ...DEFAULTS, ...fileCfg,
  relay: { ...DEFAULTS.relay, ...(fileCfg.relay || {}) },
};
if (args.count !== undefined) cfg.count = clampInt(args.count, 1, 3, 3);
if (args.rounds !== undefined) cfg.rounds = clampInt(args.rounds, 1, 20, 1);
if (args.retries !== undefined) cfg.retries = clampInt(args.retries, 0, 6, 2);
if (args.threshold !== undefined) cfg.confidenceThreshold = clampInt(args.threshold, 0, 100, 60);
if (args.model !== undefined) { cfg.codexExpectedModel = String(args.model); cfg.relay.model = String(args.model); }
if (args.baseurl !== undefined) cfg.relay.baseurl = String(args.baseurl);
if (args.apikey !== undefined) cfg.relay.apikey = String(args.apikey);
if (args.api !== undefined) cfg.relay.api = String(args.api);

const STATE_DIR = join(__dirname, '.state');
mkdirSync(STATE_DIR, { recursive: true });
const RESULTS_LOG = join(STATE_DIR, 'fp-results.jsonl');
const LAST_FILE = join(STATE_DIR, 'fp-last.json');
const FP_LOG = join(STATE_DIR, 'fp.log');

function clampInt(v, lo, hi, dflt) { const n = parseInt(v, 10); if (!Number.isFinite(n)) return dflt; return Math.min(hi, Math.max(lo, n)); }
function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  try { appendFileSync(FP_LOG, line + '\n'); } catch {}
  if (args.json) console.error(line); else console.log(line);
}

// ----------------------------- resolve binaries -----------------------------
function findNode() {
  const cands = [
    process.execPath,
    join(process.env.ProgramFiles || 'C:\\Program Files', 'nodejs', 'node.exe'),
    join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'nodejs', 'node.exe'),
    join(process.env.LOCALAPPDATA || '', 'Programs', 'nodejs', 'node.exe'),
  ];
  for (const c of cands) { try { if (c && existsSync(c)) return c; } catch {} }
  return 'node';
}
function findFpd() {
  // npm -g installs lmfpd here; fall back to its bin/fpd.js
  const root = process.env.APPDATA ? join(process.env.APPDATA, 'npm', 'node_modules', 'lmfpd') : '';
  const p = root ? join(root, 'bin', 'fpd.js') : '';
  if (p && existsSync(p)) return p;
  return null;
}
function findCodex() {
  const envb = process.env.CODEX_BRAKE_EXE;
  if (envb && existsSync(envb)) return envb;
  try {
    const binDir = join(process.env.LOCALAPPDATA || join(process.env.USERPROFILE || '', 'AppData', 'Local'), 'OpenAI', 'Codex', 'bin');
    const subs = readdirSync(binDir).sort();
    const exes = [];
    for (const s of subs) { const p = join(binDir, s, 'codex.exe'); if (existsSync(p)) { try { exes.push([p, statSync(p).mtimeMs]); } catch { exes.push([p, 0]); } } }
    if (exes.length) { exes.sort((a, b) => b[1] - a[1]); return exes[0][0]; }
  } catch {}
  try {
    const base = 'C:\\Program Files\\WindowsApps';
    const dirs = readdirSync(base).filter((d) => /^OpenAI\.Codex_/.test(d)).sort();
    for (let i = dirs.length - 1; i >= 0; i--) { const p = join(base, dirs[i], 'app', 'resources', 'codex.exe'); if (existsSync(p)) return p; }
  } catch {}
  return 'codex';
}

const NODE_BIN = findNode();
const FPD_BIN = findFpd();
const CODEX_BIN = findCodex();
const SCRATCH = join(TMP, 'fp-scratch');
try { mkdirSync(SCRATCH, { recursive: true }); } catch {}

// ----------------------------- spawn helpers -----------------------------
function runFpd(fpdArgs, { timeout = 180000 } = {}) {
  return new Promise((res) => {
    if (!FPD_BIN) return res({ ok: false, code: -1, stdout: '', stderr: 'lmfpd not installed (run: npm i -g lmfpd)' });
    let child;
    try { child = spawn(NODE_BIN, [FPD_BIN, ...fpdArgs], { shell: false, windowsHide: true, env: { ...process.env, NO_UPDATE_NOTIFIER: '1', FPD_NO_UPDATE_CHECK: '1' } }); }
    catch (e) { return res({ ok: false, code: -2, stdout: '', stderr: String(e) }); }
    let out = '', err = ''; let done = false;
    const fin = (r) => { if (done) return; done = true; res(r); };
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    const to = setTimeout(() => { try { child.kill(); } catch {} fin({ ok: false, code: -3, stdout: out, stderr: err + '\n[timeout]' }); }, timeout);
    child.on('error', (e) => { clearTimeout(to); fin({ ok: false, code: -2, stdout: out, stderr: String(e) }); });
    child.on('exit', (c) => { clearTimeout(to); fin({ ok: c === 0, code: c, stdout: out, stderr: err }); });
  });
}

function runCodexExec(prompt, outFile, { timeout = 180000 } = {}) {
  return new Promise((res) => {
    if (!CODEX_BIN) return res({ ok: false, code: -1, session: null, output: '' });
    let child;
    // IMPORTANT: stdin must be ignored. With a piped (never-closed) stdin, `codex exec`
    // prints "Reading additional input from stdin..." and blocks forever waiting for EOF.
    try { child = spawn(CODEX_BIN, ['exec', '--skip-git-repo-check', '--sandbox', 'read-only', '--cd', SCRATCH, '-o', outFile, prompt], { shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }); }
    catch (e) { return res({ ok: false, code: -2, session: null, output: String(e) }); }
    let out = '', err = ''; let done = false;
    const fin = (r) => { if (done) return; done = true; res(r); };
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    const to = setTimeout(() => { try { child.kill(); } catch {} fin({ ok: false, code: -3, session: parseSession(out + '\n' + err), output: err + '\n[timeout]' }); }, timeout);
    child.on('error', (e) => { clearTimeout(to); fin({ ok: false, code: -2, session: null, output: String(e) }); });
    child.on('exit', (c) => { clearTimeout(to); fin({ ok: c === 0, code: c, session: parseSession(out + '\n' + err), output: (out + '\n' + err) }); });
  });
}
function parseSession(s) { const m = (s || '').match(/session id:\s*([0-9a-f]{8}-[0-9a-f-]{27,})/i); return m ? m[1] : null; }

function archiveSession(id) {
  return new Promise((res) => {
    if (!CODEX_BIN || !id) return res({ ok: false, out: 'no id' });
    let child;
    try { child = spawn(CODEX_BIN, ['archive', id], { shell: false, windowsHide: true }); }
    catch (e) { return res({ ok: false, out: String(e) }); }
    let o = '', e = '';
    child.stdout.on('data', (d) => (o += d)); child.stderr.on('data', (d) => (e += d));
    child.on('error', (er) => res({ ok: false, out: String(er) }));
    child.on('exit', (c) => res({ ok: c === 0, out: (o + e).trim() }));
  });
}

// ----------------------------- core steps -----------------------------
// Generate the site's own random challenges without a live model: run lmfpd
// against a dead endpoint with --count N --output FILE. The request fails fast
// but the JSON output still contains the freshly generated challenges.
async function genChallenges(count) {
  const out = join(TMP, `fp-chal-${Date.now()}.json`);
  rmSync(out, { force: true });
  const r = await runFpd(['-b', 'http://127.0.0.1:9/v1', '-k', 'sk-none', '-m', cfg.codexExpectedModel,
    '--count', String(count), '-n', '1', '--output', out, '--timeout', '2', '--no-update-check', '--json'], { timeout: 40000 });
  if (!existsSync(out)) throw new Error('生成题目失败：' + (r.stderr || r.stdout || '').slice(0, 160));
  const j = JSON.parse(readFileSync(out, 'utf8'));
  const chs = (j.rounds && j.rounds[0] && j.rounds[0].challenges) || j.challenges || [];
  if (!chs.length) throw new Error('未能获取到题目');
  return chs; // [{id, expected_count, prompt}]
}

async function scoreInput(items) {
  const p = join(TMP, `fp-in-${Date.now()}.json`);
  writeFileSync(p, JSON.stringify(items), 'utf8');
  const r = await runFpd(['--input', p, '--json', '--no-update-check'], { timeout: 120000 });
  let j;
  try { j = JSON.parse(r.stdout); }
  catch { throw new Error('评分输出解析失败：' + (r.stderr || r.stdout || '').slice(0, 200)); }
  const round = (j.rounds || []).find((x) => x.analysis) || (j.rounds || [])[0] || {};
  return { analysis: round.analysis || null, raw: j };
}

function pctNum(v) {
  if (v == null || !Number.isFinite(Number(v))) return null;
  const n = Number(v);
  return n <= 1.0001 ? Math.round(n * 1000) / 10 : Math.round(n * 10) / 10;
}

// Normalize raw analysis into a stable result object for the UI.
function buildResult(analysis, meta) {
  const out = {
    level: 'info', label: '无法判定', degraded: false,
    expectedModel: meta.expectedModel || cfg.codexExpectedModel,
    predicted: '', predictedName: '', familyMatch: null,
    confidence: null, confidenceStatus: (analysis && analysis.probability_status) || '',
    modelLike: analysis && analysis.sequence ? !!analysis.sequence.model_like : null,
    decision: (analysis && analysis.decision) || '',
    candidates: [],
    samplesValid: meta.samplesValid, samplesTotal: meta.samplesTotal,
    mode: meta.mode, model: meta.model, reason: '',
  };
  if (!analysis) { out.reason = '没有可用的样本，无法评分。'; return out; }
  out.predicted = analysis.prediction || '';
  out.predictedName = analysis.prediction_name || '';
  // candidates: accept several possible shapes
  const raw = Array.isArray(analysis.results) ? analysis.results : (Array.isArray(analysis.candidates) ? analysis.candidates : []);
  out.candidates = raw.slice(0, 8).map((r) => ({
    name: r.model || r.name || r.label || r.id || '?',
    conf: pctNum(r.probability != null ? r.probability : (r.p != null ? r.p : r.score)),
  })).filter((c) => c.name !== '?');
  let conf = pctNum(analysis.probability);
  if (conf == null && out.candidates.length) conf = out.candidates[0].conf;
  out.confidence = conf;

  const exp = String(out.expectedModel || '').toLowerCase();
  const pred = String(out.predicted || '').toLowerCase();
  const predName = String(out.predictedName || '').toLowerCase();
  const familyMatch = !!exp && (pred === exp || predName.includes(exp) || exp.includes(pred) || (pred && predName.includes(pred)));

  const thr = cfg.confidenceThreshold;
  if (analysis.decision === 'not_model') {
    out.level = 'bad'; out.label = '异常：不像模型回复'; out.degraded = true;
    out.reason = '回复不像大模型正常生成的数字（可能乱答或程序生成），判定异常。';
    out.familyMatch = false;
  } else if (!out.predicted) {
    out.level = 'info'; out.label = '样本不足'; out.reason = '有效样本不足，无法给出判定。';
  } else {
    out.familyMatch = familyMatch;
    if (familyMatch && (conf == null || conf >= thr)) {
      out.level = 'ok'; out.label = '正常'; out.reason = `判定为 ${out.predictedName || out.predicted}，与预期一致` + (conf != null ? `（置信度 ${conf}%）` : '（样本不足无置信度）');
    } else if (familyMatch && conf != null && conf < thr) {
      out.level = 'warn'; out.label = '正常但置信度偏低'; out.reason = `族匹配，但置信度仅 ${conf}%（阈值 ${thr}%）。`;
    } else if (!familyMatch && conf != null && conf >= 50) {
      out.level = 'bad'; out.label = '疑似降智/掉包'; out.degraded = true;
      out.reason = `判定为 ${out.predictedName || out.predicted}，与预期 ${out.expectedModel} 不符（置信度 ${conf}%）。`;
    } else {
      out.level = 'warn'; out.label = '偏差但不确定'; out.reason = `最像 ${out.predictedName || out.predicted}，与预期 ${out.expectedModel} 不同，但置信度不足。`;
    }
  }
  return out;
}

// ----------------------------- mode: codex -----------------------------
async function runCodexMode() {
  const count = cfg.count;
  const challenges = await genChallenges(count);
  log(`已生成 ${challenges.length} 道官方随机题`);
  const minN = (ch) => Math.max(80, Math.ceil((ch.expected_count || 300) * 0.5));

  // Run samples SEQUENTIALLY: the local Codex daemon serialises turns, so parallel
  // `codex exec` calls block each other and all time out. One at a time is slower
  // but reliable (~60-90s each).
  const results = [];
  for (let i = 0; i < challenges.length; i++) {
    const ch = challenges[i];
    let last = { ok: false, session: null, text: '', digits: 0, code: null };
    for (let attempt = 0; attempt <= cfg.retries; attempt++) {
      const outFile = join(TMP, `fp-reply-${Date.now()}-${i}-${attempt}.txt`);
      rmSync(outFile, { force: true });
      log(`样本 ${i + 1}/${challenges.length} 发送给 Codex（第 ${attempt + 1} 次）…`);
      const r = await runCodexExec(ch.prompt, outFile);
      const text = existsSync(outFile) ? readFileSync(outFile, 'utf8') : '';
      const digits = (text.match(/\d+/g) || []).length;
      last = { ok: false, session: r.session, text, digits, code: r.code };
      if (r.ok && digits >= minN(ch)) { last.ok = true; log(`样本 ${i + 1} 成功：${digits} 个数字，session ${r.session || '?'}`); break; }
      log(`样本 ${i + 1} 失败（exit ${r.code}，${digits} 个数字，需≥${minN(ch)}）` + (attempt < cfg.retries ? '，重试' : '，放弃'));
    }
    results.push({ ch, ...last });
  }

  const good = results.filter((x) => x.ok);
  const samplesValid = good.length, samplesTotal = challenges.length;
  let analysis = null;
  if (samplesValid > 0) {
    const items = good.map((g) => ({ id: g.ch.id, prompt: g.ch.prompt, expected_count: g.ch.expected_count, text: g.text }));
    const sc = await scoreInput(items);
    analysis = sc.analysis;
  }

  // archive the test sessions (user wants the 3 sent chats archived)
  const archived = [];
  for (const r of results) {
    if (r.session) { const a = await archiveSession(r.session); archived.push({ id: r.session, ok: a.ok }); log(`归档 ${r.session}: ${a.ok ? 'ok' : a.out.slice(0, 80)}`); }
  }

  const result = buildResult(analysis, { mode: 'codex', model: 'Codex(' + cfg.codexExpectedModel + ')', expectedModel: cfg.codexExpectedModel, samplesValid, samplesTotal });
  return { ok: true, mode: 'codex', result, archived, rawAnalysis: analysis };
}

// ----------------------------- mode: relay -----------------------------
async function runRelayMode() {
  const rl = cfg.relay;
  if (!rl.baseurl || !rl.model) throw new Error('请先在“中转站配置”里填写 Base URL 和模型名。');
  const out = join(TMP, `fp-relay-${Date.now()}.json`);
  rmSync(out, { force: true });
  const fpdArgs = ['-b', rl.baseurl, '-m', rl.model, '--count', String(cfg.count), '-n', String(cfg.rounds),
    '--json', '--output', out, '--no-update-check'];
  if (rl.apikey) fpdArgs.push('-k', rl.apikey);
  if (rl.api) fpdArgs.push('--api', rl.api);
  if (rl.image) fpdArgs.push('--image');
  fpdArgs.push('--timeout', String(rl.timeoutSec || 120));

  let analysis = null, j = null, lastErr = '';
  for (let attempt = 0; attempt <= cfg.retries; attempt++) {
    log(`中转站检测（第 ${attempt + 1} 次）→ ${rl.baseurl} / ${rl.model}`);
    const r = await runFpd(fpdArgs, { timeout: (rl.timeoutSec || 120) * 1000 * cfg.rounds + 60000 });
    if (existsSync(out)) { try { j = JSON.parse(readFileSync(out, 'utf8')); } catch { j = null; } }
    if (!j && r.stdout) { try { j = JSON.parse(r.stdout); } catch {} }
    const round = j && (j.rounds || []).find((x) => x.analysis);
    analysis = round ? round.analysis : null;
    if (analysis && analysis.prediction) { break; }
    // Build a short human error: prefer a per-round error message, else last line of stderr.
    let msg = '';
    try {
      const rr = j && (j.rounds || []).find((x) => x && x.error) || (j && j.rounds && j.rounds[0]);
      if (rr && rr.error) msg = typeof rr.error === 'string' ? rr.error : JSON.stringify(rr.error);
    } catch {}
    if (!msg && r.stderr) msg = r.stderr.trim().split(/\r?\n/).filter(Boolean).pop() || '';
    lastErr = (msg || '无有效结果').slice(0, 200);
    if (attempt < cfg.retries) log('未取得有效判定，重试… ' + lastErr);
  }
  if (!analysis) throw new Error('中转站检测失败：' + (lastErr || '无有效结果（检查 baseurl/key/模型名/协议是否正确）'));
  const result = buildResult(analysis, { mode: 'relay', model: rl.model, expectedModel: rl.model, samplesValid: cfg.count, samplesTotal: cfg.count });
  return { ok: true, mode: 'relay', result, rawAnalysis: analysis };
}

// ----------------------------- record / report -----------------------------
function record(run) {
  const now = new Date();
  const rec = {
    ts: now.toISOString(),
    date: localDate(now),
    mode: run.mode,
    model: run.result.model,
    predicted: run.result.predicted,
    predictedName: run.result.predictedName,
    confidence: run.result.confidence,
    level: run.result.level,
    label: run.result.label,
    degraded: run.result.degraded,
    familyMatch: run.result.familyMatch,
    samplesValid: run.result.samplesValid,
    samplesTotal: run.result.samplesTotal,
    reason: run.result.reason,
  };
  try { appendFileSync(RESULTS_LOG, JSON.stringify(rec) + '\n'); } catch {}
  try { writeFileSync(LAST_FILE, JSON.stringify({ ...rec, result: run.result, archived: run.archived || [] }, null, 2)); } catch {}
  return rec;
}
function localDate(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function readLog(days) {
  const out = [];
  if (!existsSync(RESULTS_LOG)) return out;
  const cutoff = days ? Date.now() - days * 86400000 : 0;
  for (const line of readFileSync(RESULTS_LOG, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try { const o = JSON.parse(line); if (new Date(o.ts).getTime() >= cutoff) out.push(o); } catch {}
  }
  return out;
}

async function doRun(mode) {
  const started = Date.now();
  let run;
  try {
    run = mode === 'relay' ? await runRelayMode() : await runCodexMode();
  } catch (e) {
    const errRun = { ok: false, mode, error: String(e && e.message || e) };
    if (args.json) process.stdout.write(JSON.stringify(errRun));
    else console.log('FAILED: ' + errRun.error);
    process.exitCode = 1;
    return;
  }
  run.elapsedSec = Math.round((Date.now() - started) / 1000);
  const rec = record(run);
  const payload = {
    ok: true, mode: run.mode, elapsedSec: run.elapsedSec,
    recorded: rec, result: run.result, archived: run.archived || [],
  };
  if (args.json) process.stdout.write(JSON.stringify(payload));
  else {
    console.log(`\n=== 检测结果（${run.mode === 'relay' ? '中转站' : 'Codex'}，用时 ${run.elapsedSec}s）===`);
    console.log(`判定：${run.result.label}  ${run.result.degraded ? '⚠️降智' : ''}`);
    console.log(run.result.reason);
    if (run.result.candidates.length) console.log('候选：' + run.result.candidates.map((c) => `${c.name}${c.conf != null ? '(' + c.conf + '%)' : ''}`).join('  '));
    if ((run.archived || []).length) console.log('已归档会话：' + run.archived.filter((a) => a.ok).length + '/' + run.archived.length);
  }
}

// ----------------------------- dispatch -----------------------------
if (args.help) {
  console.log(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('*/')[0]);
  process.exit(0);
} else if (args.run) {
  await doRun(String(args.mode || 'codex').toLowerCase());
} else if (args.status) {
  const last = existsSync(LAST_FILE) ? JSON.parse(readFileSync(LAST_FILE, 'utf8')) : null;
  if (args.json) process.stdout.write(JSON.stringify({ ok: true, last }));
  else console.log(last ? JSON.stringify(last, null, 2) : '（暂无检测记录）');
} else if (args.log !== undefined) {
  const days = args.days !== undefined ? parseInt(args.days, 10) : 30;
  const rows = readLog(days);
  if (args.json) process.stdout.write(JSON.stringify({ ok: true, days, count: rows.length, rows }));
  else console.log(rows.map((r) => `${r.date} ${r.mode} ${r.label} ${r.predictedName || ''} ${r.confidence ?? ''}`).join('\n') || '（无记录）');
} else {
  console.log('fingerprint.mjs — use --run --mode codex|relay, --status, or --log [--days N]');
}
