// Headless Chrome over the DevTools protocol, with Node's own WebSocket (no dependencies).
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const env = (k, d) => process.env[k] ?? d;

export async function launch() {
  const dir = mkdtempSync(join(tmpdir(), 'swap-bench-'));
  const proc = spawn(env('CHROME', 'google-chrome'), [
    '--headless=new', '--remote-debugging-port=0', `--user-data-dir=${dir}`, '--no-first-run',
    '--no-default-browser-check', '--disable-extensions', '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows', 'about:blank',
  ], { stdio: ['ignore', 'ignore', 'pipe'] });
  const wsUrl = await new Promise((ok, fail) => {
    let err = '';
    proc.stderr.on('data', (d) => { err += d; const m = err.match(/DevTools listening on (ws:\S+)/); if (m) ok(m[1]); });
    proc.on('exit', (c) => fail(new Error(`chrome exited (${c}): ${err.slice(-500)}`)));
  });
  const ws = new WebSocket(wsUrl);
  await new Promise((ok, fail) => { ws.onopen = ok; ws.onerror = fail; });
  let id = 0;
  const pending = new Map(), waiters = [];
  ws.onmessage = ({ data }) => {
    const m = JSON.parse(data);
    if (m.id != null) {
      const p = pending.get(m.id); pending.delete(m.id);
      m.error ? p.fail(new Error(`${p.method}: ${m.error.message}`)) : p.ok(m.result);
    } else for (const w of [...waiters]) if (w.method === m.method && w.sessionId === m.sessionId) { waiters.splice(waiters.indexOf(w), 1); w.ok(m.params); }
  };
  const send = (method, params = {}, sessionId) => new Promise((ok, fail) => {
    pending.set(++id, { ok, fail, method });
    ws.send(JSON.stringify({ id, method, params, sessionId }));
  });
  const once = (method, sessionId) => new Promise((ok) => waiters.push({ method, sessionId, ok }));
  const close = async () => {
    ws.close();
    const exited = new Promise((ok) => proc.once('exit', ok));
    proc.kill();
    await exited;
    rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
  };
  return { send, once, close };
}

/** Opens `url` in a new tab, waits for load, runs `fn(session)`, closes the tab. */
export async function withPage(chrome, url, fn, { cpu = 1 } = {}) {
  const { send, once } = chrome;
  const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  try {
    await send('Page.enable', {}, sessionId);
    if (cpu > 1) await send('Emulation.setCPUThrottlingRate', { rate: cpu }, sessionId);
    const loaded = once('Page.loadEventFired', sessionId);
    await send('Page.navigate', { url }, sessionId);
    await loaded;
    return await fn((method, params) => send(method, params, sessionId));
  } finally {
    await send('Target.closeTarget', { targetId });
  }
}

/** Evaluates an expression in the page and returns its (awaited) value. */
export async function evaluate(send, expression) {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
  return r.result.value;
}

