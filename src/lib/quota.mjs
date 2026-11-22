// lib/quota.mjs — 读 Codex 额度（app-server JSON-RPC），配额工具共用
//
// `account/rateLimits/read` 是 app-server 的一次读操作，不是模型请求，不消耗额度。
// 这里只做三件事：解析 codex.exe、起一个临时的 app-server、把它返回的窗口规范化。
import { spawn } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

/** 解析一个可直接 spawn 的 codex.exe（不走 PATH 上的 .ps1/.cmd shim）。 */
export function resolveCodexBin({ explicit = null, envVar = 'CODEX_BRAKE_EXE', log = () => {} } = {}) {
  if (explicit) {
    if (existsSync(explicit)) return explicit;
    log('WARN: codexBin 不存在，回落到自动探测: ' + explicit);
  }
  if (envVar && process.env[envVar] && existsSync(process.env[envVar])) return process.env[envVar];
  // 优先 per-user CLI（WindowsApps 下的 MSIX 目录在 Node 里枚举受限）
  const base = join(process.env.LOCALAPPDATA || join(process.env.USERPROFILE || '', 'AppData', 'Local'), 'OpenAI', 'Codex', 'bin');
  try {
    const cands = [];
    for (const d of readdirSync(base)) {
      const p = join(base, d, 'codex.exe');
      if (existsSync(p)) cands.push({ p, m: statSync(p).mtimeMs });
    }
    cands.sort((a, b) => b.m - a.m);
    if (cands.length) return cands[0].p;
  } catch { /* fall through */ }
  return 'codex.exe';
}

/** 一个最小的 app-server JSON-RPC 客户端：起进程、发一两个请求、关掉。 */
export class AppServerClient {
  constructor(exe, clientName = 'quota-tools') {
    this.exe = exe; this.clientName = clientName;
    this.proc = null; this.buf = ''; this.pending = new Map(); this.seq = 1; this.stderr = '';
  }

  start(timeoutMs = 20000) {
    return new Promise((resolveP, rejectP) => {
      let done = false;
      const to = setTimeout(() => { if (!done) { done = true; this.stop(); rejectP(new Error('app-server start timeout')); } }, timeoutMs);
      try {
        this.proc = spawn(this.exe, ['app-server'], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
      } catch (e) { clearTimeout(to); return rejectP(e); }
      this.proc.stderr.on('data', (d) => { this.stderr += d.toString().slice(0, 2000); });
      this.proc.stdout.on('data', (d) => {
        this.buf += d.toString();
        let idx;
        while ((idx = this.buf.indexOf('\n')) >= 0) {
          const line = this.buf.slice(0, idx).trim();
          this.buf = this.buf.slice(idx + 1);
          if (!line) continue;
          let msg; try { msg = JSON.parse(line); } catch { continue; }
          if (msg.id !== undefined && this.pending.has(msg.id)) {
            const { res, rej } = this.pending.get(msg.id);
            this.pending.delete(msg.id);
            if (msg.error) rej(new Error(JSON.stringify(msg.error).slice(0, 300)));
            else res(msg.result);
          }
        }
      });
      this.proc.on('error', (e) => { if (!done) { done = true; clearTimeout(to); rejectP(e); } });
      this.proc.on('exit', () => { for (const { rej } of this.pending.values()) rej(new Error('app-server exited')); this.pending.clear(); });
      this.call('initialize', { clientInfo: { name: this.clientName, version: '1.0.0' } }, timeoutMs)
        .then((r) => { done = true; clearTimeout(to); resolveP(r); })
        .catch((e) => { if (!done) { done = true; clearTimeout(to); rejectP(e); } });
    });
  }

  call(method, params, timeoutMs = 20000) {
    const id = this.seq++;
    return new Promise((res, rej) => {
      const to = setTimeout(() => { this.pending.delete(id); rej(new Error('timeout ' + method)); }, timeoutMs);
      this.pending.set(id, {
        res: (v) => { clearTimeout(to); res(v); },
        rej: (e) => { clearTimeout(to); rej(e); },
      });
      try { this.proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n'); }
      catch (e) { clearTimeout(to); this.pending.delete(id); rej(e); }
    });
  }

  stop() { try { this.proc && this.proc.stdin.end(); } catch {} try { this.proc && this.proc.kill(); } catch {} }
}

/** 把 primary/secondary 规范化成 [{label, usedPercent, resetsAt, windowMins}]。 */
export function classifyWindows(rateLimits) {
  const raw = [];
  const push = (w, fallbackLabel) => {
    if (!w || typeof w.usedPercent !== 'number') return;
    const mins = Number(w.windowDurationMins) || null;
    let label = fallbackLabel;
    if (mins === 300) label = '5h';
    else if (mins === 10080) label = 'weekly';
    else if (mins) label = Math.round(mins / 60) + 'h';
    raw.push({ label, usedPercent: w.usedPercent, resetsAt: w.resetsAt ?? null, windowMins: mins });
  };
  push(rateLimits && rateLimits.primary, '5h');
  push(rateLimits && rateLimits.secondary, 'weekly');
  const seen = new Set();
  return raw.filter((w) => {
    const k = w.label + ':' + w.usedPercent + ':' + (w.resetsAt || '');
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/** 读一次额度。成功返回 {ok:true, windows, exe, allowed}，失败返回 {ok:false, error, exe}。 */
export async function readQuotaOnce({ exe, clientName = 'quota-tools', startTimeoutMs = 25000, callTimeoutMs = 20000 } = {}) {
  const bin = exe || resolveCodexBin();
  const client = new AppServerClient(bin, clientName);
  try {
    await client.start(startTimeoutMs);
    const resp = await client.call('account/rateLimits/read', {}, callTimeoutMs);
    const windows = classifyWindows(resp && resp.rateLimits);
    if (!windows.length) return { ok: false, error: 'no rate-limit windows in response', exe: bin };
    return { ok: true, windows, exe: bin, accountId: resp.accountId || null, allowed: resp.ordinaryUsageAllowed ?? null };
  } catch (e) {
    return { ok: false, error: e.message, exe: bin };
  } finally {
    client.stop();
  }
}
