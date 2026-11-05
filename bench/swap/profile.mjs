// CPU profile of one variant's swaps: self time per function, heaviest first.
//   CHROME=/path/to/chrome node profile.mjs [variant=sinter] [n=5000] [scenario=replace]
// The sinter page is built unminified for this, so function names are readable; run.mjs rebuilds
// the minified page before measuring.
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { evaluate, launch, withPage } from './cdp.mjs';
import { start } from './server.mjs';

const here = fileURLToPath(new URL('.', import.meta.url));
const [variant = 'sinter', n = '5000', scenario = 'replace'] = process.argv.slice(2);
const path = variant === 'sinter' ? (scenario === 'append' ? '/sinter/append.html' : '/sinter/') : `/${variant}.html`;
const build = spawnSync('npx', ['vite', 'build', '--logLevel', 'warn'], { cwd: here, stdio: 'inherit', env: { ...process.env, MINIFY: '0' } });
if (build.status) process.exit(1);

const server = await start();
const chrome = await launch();
try {
  const { profile, times } = await withPage(chrome, `${server.url}${path}?n=${n}&s=${scenario}`, async (send) => {
    await evaluate(send, 'window.__bench.run({ warmup: 5, iterations: 5 })'); // warm up the JIT
    await send('Profiler.enable');
    await send('Profiler.setSamplingInterval', { interval: 100 });
    await send('Profiler.start');
    const times = await evaluate(send, 'window.__bench.run({ warmup: 0, iterations: 30 })');
    const { profile } = await send('Profiler.stop');
    return { profile, times };
  });
  const self = new Map(), dt = new Map();
  profile.samples.forEach((id, i) => dt.set(id, (dt.get(id) ?? 0) + (profile.timeDeltas[i] ?? 0)));
  let total = 0;
  for (const node of profile.nodes) {
    const { functionName, url, lineNumber } = node.callFrame;
    if (['(idle)', '(program)'].includes(functionName)) continue;
    const t = (dt.get(node.id) ?? 0) / 1000;
    if (!t) continue;
    total += t;
    const file = url.split('/').pop();
    const k = `${functionName || '(anonymous)'}${file ? ` ${file}:${lineNumber + 1}` : ''}`;
    self.set(k, (self.get(k) ?? 0) + t);
  }
  const med = (xs) => [...xs].sort((a, b) => a - b)[xs.length >> 1];
  console.log(`${variant} n=${n} ${scenario}: dom median ${med(times.dom).toFixed(1)} ms, layout ${med(times.layout).toFixed(1)} ms; ${total.toFixed(0)} ms busy over 30 swaps\n`);
  console.log('self ms   share  function');
  for (const [k, t] of [...self].sort((a, b) => b[1] - a[1]).slice(0, +(process.env.TOP ?? 30)))
    console.log(`${t.toFixed(1).padStart(7)}  ${((100 * t) / total).toFixed(1).padStart(5)}%  ${k}`);
} finally {
  await chrome.close().catch(() => {});
  await server.close();
}
