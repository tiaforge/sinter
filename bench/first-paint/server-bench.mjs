// server cost per page: CPU time of the server process per request (/proc), latency, throughput
import { readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
const servers = [['static', 4360], ['middleware', 4358], ['qwik', 4353]].filter(([n]) => !process.argv[2] || process.argv[2].split(',').includes(n));
const paths = { static: ['/', '/article/article-3'], middleware: ['/', '/article/article-3'], qwik: ['/', '/article/article-3/'] };
const match = { 4360: 'dist-static-plain [4]360', 4358: 'dist-plain [4]358', 4353: 'serve.mjs [4]353', 4400: 'cmp/[a]pi.mjs' };
const pidOf = (port) => execSync(`pgrep -f '${match[port]}' | head -1`).toString().trim();
const cpu = (pid) => { const f = readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1].split(' '); return (+f[11] + +f[12]) * 10; }; // utime+stime, ms (100 Hz)
const get = async (url) => { const t = performance.now(); const r = await fetch(url, { headers: { 'accept-encoding': 'gzip' } }); await r.arrayBuffer(); return performance.now() - t; };
const apiPid = pidOf(4400);
for (const [name, port] of servers) for (const [k, path] of paths[name].entries()) {
  const url = `http://localhost:${port}${path}`, pid = pidOf(port);
  for (let i = 0; i < 30; i++) await get(url); // warm (JIT, caches)
  let c0 = cpu(pid), a0 = cpu(apiPid); const lat = [];
  for (let i = 0; i < 200; i++) lat.push(await get(url));
  const cpuMs = (cpu(pid) - c0) / 200, apiMs = (cpu(apiPid) - a0) / 200;
  lat.sort((a, b) => a - b);
  const t = performance.now(); let n = 0;
  await Promise.all(Array.from({ length: 10 }, async () => { while (n < 400) { n++; await get(url); } }));
  const rps = 400 / ((performance.now() - t) / 1000);
  console.log(`${name.padEnd(10)} ${(k ? 'article' : 'home').padEnd(8)} server CPU ${cpuMs.toFixed(2)} ms/req (API ${apiMs.toFixed(2)})  latency p50 ${lat[100].toFixed(1)} ms p90 ${lat[180].toFixed(1)} ms  throughput ${Math.round(rps)} req/s (10 concurrent)`);
}
