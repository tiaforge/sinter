// Self time by function for one variant at one rate (CPU profile over the DevTools protocol).
//   MINIFY=0 ONLY=sinter node build.mjs   (readable names)
//   CHROME=… node profile.mjs sinter 1000 [cpu=4] [ms=2000] [query, e.g. n=10000&k=100&sort=1]
import { spawn } from 'node:child_process';
import { launch, withPage } from '../swap/cdp.mjs';

const [variant = 'sinter', rate = '1000', cpu = '4', ms = '2000', query = ''] = process.argv.slice(2);
const idle = (t) => new Promise((r) => setTimeout(r, t));
const server = spawn(process.execPath, ['server.mjs', '0'], { cwd: import.meta.dirname, stdio: ['ignore', 'pipe', 'inherit'] });
const base = await new Promise((ok) => server.stdout.on('data', (d) => { const m = String(d).match(/http:\/\/[\d.:]+/); if (m) ok(m[0]); }));
const chrome = await launch();
try {
  await withPage(chrome, `${base}/${variant}/${query ? '?' + query : ''}`, async (send) => {
    await idle(300);
    await fetch(`${base}/control?rate=${rate}`);
    await idle(500);
    await send('Profiler.enable');
    await send('Profiler.setSamplingInterval', { interval: 100 });
    await send('Profiler.start');
    await idle(+ms);
    const { profile } = await send('Profiler.stop');
    await fetch(`${base}/control?rate=0`);
    const dt = profile.timeDeltas, byId = new Map(profile.nodes.map((n) => [n.id, n]));
    const self = new Map();
    let total = 0;
    profile.samples.forEach((id, i) => {
      const n = byId.get(id), f = n.callFrame, t = dt[i] / 1000;
      const key = `${f.functionName || '(anonymous)'} ${f.url.split('/').pop()}:${f.lineNumber + 1}`;
      self.set(key, (self.get(key) ?? 0) + t); total += t;
    });
    console.log(`${variant} ${rate}/s, CPU ${cpu}x, ${ms} ms: self time, ms (total ${total.toFixed(0)})`);
    for (const [k, t] of [...self].sort((a, b) => b[1] - a[1]).slice(0, 30)) console.log(t.toFixed(1).padStart(8), k);
  }, { cpu: +cpu });
} finally { server.kill(); await chrome.close().catch(() => {}); }
