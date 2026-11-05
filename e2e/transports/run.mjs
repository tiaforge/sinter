// End-to-end test of <sn-sync> over SSE, WebSocket and SignalR against real servers, in headless
// Chrome. Builds the pages, starts the ASP.NET Core hub (signalr/) and the Node backend
// (server.mjs), then runs one scenario per transport and exits non-zero on any failure.
//   CHROME=/path/to/chrome DOTNET=~/.dotnet/dotnet node run.mjs [sse,ws,signalr]
import { spawn, spawnSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { evaluate, launch, withPage } from '../../bench/swap/cdp.mjs';
import { start } from './server.mjs';

const here = fileURLToPath(new URL('.', import.meta.url));
const TRANSPORTS = (process.argv[2] ?? 'sse,ws,signalr').split(',');
const HUB_PORT = +(process.env.HUB_PORT ?? 5099);

if (spawnSync('npx', ['vite', 'build', '--logLevel', 'warn'], { cwd: here, stdio: 'inherit' }).status) process.exit(1);

/** Polls `fn` until it returns {ok: true}; fails with the last value seen. */
async function until(what, fn, ms = 10_000) {
  const t0 = Date.now();
  let last;
  while (Date.now() - t0 < ms) {
    last = await fn();
    if (last.ok) return last.value;
    await delay(50);
  }
  throw new Error(`${what}; last seen: ${JSON.stringify(last?.value)}`);
}

async function startHub() {
  const dotnet = process.env.DOTNET ?? 'dotnet';
  const proc = spawn(dotnet, ['run', '--project', 'signalr', '--', '--urls', `http://127.0.0.1:${HUB_PORT}`], {
    cwd: here, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, DOTNET_CLI_TELEMETRY_OPTOUT: '1', DOTNET_NOLOGO: '1' },
  });
  let log = '';
  proc.stdout.on('data', (d) => { log += d; });
  proc.stderr.on('data', (d) => { log += d; });
  const exited = new Promise((ok) => proc.once('exit', ok));
  try {
    await until('the SignalR hub did not start (dotnet run)', async () => {
      if (proc.exitCode != null) throw new Error(`dotnet exited (${proc.exitCode}):\n${log.slice(-2000)}`);
      const r = await fetch(`http://127.0.0.1:${HUB_PORT}/control/stats`).catch(() => null);
      return { ok: !!r?.ok };
    }, 180_000);
  } catch (e) { proc.kill(); throw e; }
  return { close: async () => { proc.kill(); await exited; } };
}

const hub = TRANSPORTS.includes('signalr') ? await startHub() : null;
const server = await start({ hub: `http://127.0.0.1:${HUB_PORT}` });
const chrome = await launch();
const results = [];

const SRC = { sse: '/sse/people', ws: '/ws/people', signalr: '/hubs/people' };

async function scenario(t, send) {
  const ctl = async (path, body) => (await fetch(`${server.url}/control/${path}?t=${t}`, body === undefined
    ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })).json();
  const list = () => evaluate(send, `[...document.querySelectorAll('#people li')].map((li) => li.textContent)`);
  const shows = (want) => until(`list should be ${JSON.stringify(want)}`, async () => {
    const value = await list();
    return { ok: JSON.stringify(value) === JSON.stringify(want), value };
  });
  const connected = (n) => until(`${n} open ${t} connection(s) expected`, async () => {
    const value = await ctl('stats');
    return { ok: value.connected === n, value };
  });
  const step = async (name, fn) => {
    const t0 = performance.now();
    try { await fn(); results.push({ t, name, ok: true, ms: performance.now() - t0 }); }
    catch (e) { results.push({ t, name, ok: false, ms: performance.now() - t0, error: e.message }); throw e; }
  };

  await step('initial load', () => shows(['Bob']));
  await step(`connects (${SRC[t]})`, async () => {
    const s = await connected(1);
    if (t === 'signalr' && s.hubUpgrades !== 1) throw new Error(`expected the hub over WebSocket, saw ${s.hubUpgrades} upgrade(s)`);
  });
  await step('upsert event', async () => {
    await ctl('emit', { event: 'person_updated', data: { person: { id: 2, name: 'Ada' } } });
    await shows(['Ada', 'Bob']);
  });
  await step('remove event', async () => {
    await ctl('emit', { event: 'person_removed', data: { id: 1 } });
    await shows(['Ada']);
  });
  await step('unmapped event is ignored', async () => {
    await ctl('emit', { event: 'person_archived', data: { id: 2 } });
    await delay(300);
    const value = await list();
    if (JSON.stringify(value) !== '["Ada"]') throw new Error(`list changed: ${JSON.stringify(value)}`);
  });
  let before;
  await step('connection cut (network) → probe, reconnect, refetch', async () => {
    await ctl('set', [{ id: 2, name: 'Ada' }, { id: 3, name: 'Cy' }]); // a change no event announced
    before = await ctl('stats');
    await ctl('drop');
    await shows(['Ada', 'Cy']);
    const after = await connected(1);
    if (after.probes <= before.probes) throw new Error(`no session probe (${before.probes} → ${after.probes})`);
  });
  await step('exactly one new connection (no second reconnect loop)', async () => {
    await delay(1500); // a browser- or library-driven reconnect would show up here
    const s = await ctl('stats');
    if (s.connected !== 1 || s.total !== before.total + 1) throw new Error(`connected ${s.connected}, total ${before.total} → ${s.total}`);
    if (t === 'signalr' && s.hubUpgrades !== 2) throw new Error(`the reconnect did not use WebSocket (${s.hubUpgrades} upgrades)`);
  });
  await step('events on the new connection', async () => {
    await ctl('emit', { event: 'person_updated', data: { person: { id: 4, name: 'Dan' } } });
    await shows(['Ada', 'Cy', 'Dan']);
  });
  if (t === 'signalr') await step('hub aborts the connection (server-side close) → reconnect, refetch', async () => {
    await ctl('set', [{ id: 2, name: 'Ada' }, { id: 5, name: 'Eve' }]);
    const s0 = await ctl('stats');
    await ctl('abort');
    await shows(['Ada', 'Eve']);
    const s1 = await connected(1);
    if (s1.total !== s0.total + 1 || s1.probes <= s0.probes) throw new Error(`total ${s0.total} → ${s1.total}, probes ${s0.probes} → ${s1.probes}`);
  });
}

try {
  for (const t of TRANSPORTS) {
    await fetch(`${server.url}/control/set`, { method: 'POST', body: JSON.stringify([{ id: 1, name: 'Bob' }]) });
    const errors = [];
    await withPage(chrome, `${server.url}/${t}.html`, async (send) => {
      await send('Runtime.enable');
      try { await scenario(t, send); } catch { /* recorded by step() */ }
    }).catch((e) => errors.push(e));
    for (const e of errors) results.push({ t, name: 'page', ok: false, ms: 0, error: e.message });
  }
} finally {
  await chrome.close().catch(() => {});
  await server.close();
  await hub?.close();
}

console.log('| transport | step | result | ms |\n| --- | --- | --- | ---: |');
for (const r of results) console.log(`| ${r.t} | ${r.name} | ${r.ok ? 'pass' : `**FAIL**: ${r.error}`} | ${r.ms.toFixed(0)} |`);
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} steps passed`);
process.exit(failed ? 1 : 0);
