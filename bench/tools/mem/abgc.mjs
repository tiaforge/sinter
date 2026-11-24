// node abgc.mjs <rounds> <variant> <n> [more variant:n…]: base and cur apps interleaved, whole process (--trace-gc), medians
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
const [rounds, ...specs] = process.argv.slice(2);
const jobs = specs.map((s) => s.split(':'));
const gc = (t) => { let s = 0, m = 0, ns = 0; for (const l of t.split('\n')) { const x = /ms: (Scavenge|Mark-Compact)[^,]*MB, (?:pooled: [\d.]+ MB, )?([\d.]+) \//.exec(l); if (!x) continue; if (x[1] === 'Scavenge') { s += +x[2]; ns++; } else m += +x[2]; } return { s, m, ns }; };
const res = {};
for (let r = 0; r < +rounds; r++) for (const [v, n] of jobs) for (const side of (r % 2 ? ['cur', 'base'] : ['base', 'cur'])) {
  const repo = side === 'cur' ? '/home/user/sinter' : '/home/user/sinter-base';
  const p = spawnSync(process.execPath, ['--trace-gc', `${repo}/bench/astro/run-sinter.mjs`, `/home/user/apps/${side}-${v}-${n}`], { encoding: 'utf8', maxBuffer: 1 << 28, env: { ...process.env, ...(process.env[`ENV_${side}`] ? Object.fromEntries(process.env[`ENV_${side}`].split(',').map((x) => x.split('='))) : {}) } });
  const j = JSON.parse(p.stdout.trim().split('\n').filter((l) => l.startsWith('{"ms"')).at(-1));
  if (j.error) throw new Error(j.error);
  const g = gc(p.stdout);
  (res[`${v}-${n} ${side}`] ??= []).push({ ms: j.ms, rss: j.maxRssMb, gc: g.s + g.m, sc: g.s, mc: g.m, ns: g.ns });
}
const med = (a) => { const s = [...a].sort((x, y) => x - y); return s.length % 2 ? s[s.length >> 1] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2; };
for (const [k, rs] of Object.entries(res)) console.log(k.padEnd(18), 'ms', med(rs.map((x) => x.ms)), ' rss', med(rs.map((x) => x.rss)), ' gc', med(rs.map((x) => x.gc)).toFixed(0), `(scav ${med(rs.map((x) => x.sc)).toFixed(0)} in ${med(rs.map((x) => x.ns))}, mc ${med(rs.map((x) => x.mc)).toFixed(0)})`, ' runs', rs.map((x) => `${x.ms}/${x.rss}/${x.gc.toFixed(0)}`).join(' '));
