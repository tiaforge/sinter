// open-loop load stepped up until it breaks: latency seen by the load, and the CPU of each process (% of one core)
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
const [url, match, ...rates] = process.argv.slice(2);
const pid = (m) => execSync(`pgrep -f '${m}' | head -1`).toString().trim();
const pids = { server: pid(match), api: pid('cmp/[a]pi.mjs') };
const ticks = (p) => { const f = readFileSync(`/proc/${p}/stat`, 'utf8').split(') ')[1].split(' '); return +f[11] + +f[12]; };
const self = () => { const u = process.cpuUsage(); return (u.user + u.system) / 1000; };
const agent = new http.Agent({ keepAlive: true, maxSockets: 1024 });
for (const rate of rates.map(Number)) {
  const lat = [], secs = 6; let errors = 0, sent = 0;
  const t0 = { s: ticks(pids.server), a: ticks(pids.api), g: self(), t: performance.now() };
  await new Promise((done) => {
    const per = rate / 100, start = performance.now();
    let owed = 0;
    const iv = setInterval(() => {
      owed += per;
      for (; owed >= 1; owed--) {
        sent++;
        const t = performance.now();
        http.get(url, { agent, headers: { 'accept-encoding': 'gzip' }, timeout: 10000 }, (res) => { res.on('data', () => {}); res.on('end', () => lat.push(performance.now() - t)); })
          .on('error', () => errors++).on('timeout', function () { errors++; this.destroy(); });
      }
      if (performance.now() - start > secs * 1000) { clearInterval(iv); setTimeout(done, 1500); }
    }, 10);
  });
  const el = (performance.now() - t0.t) / 1000;
  const pct = (d) => Math.round((d / 100 / el) * 100);
  lat.sort((a, b) => a - b);
  const q = (p) => (lat.length ? lat[Math.min(lat.length - 1, Math.floor(lat.length * p))].toFixed(1) : '-');
  console.log(`${String(rate).padStart(5)}/s sent ${sent} done ${lat.length} errors ${errors} | p50 ${q(0.5)} p90 ${q(0.9)} p99 ${q(0.99)} ms | CPU server ${pct(ticks(pids.server) - t0.s)}% api ${pct(ticks(pids.api) - t0.a)}% load ${Math.round(((self() - t0.g) / 1000 / el) * 100)}%`);
  await new Promise((r) => setTimeout(r, 1000));
}
process.exit(0);
