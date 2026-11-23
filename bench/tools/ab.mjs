// node ab.mjs <rounds> <appA> <appB> [phases...]: interleaved builds with the phase preload (instr.mjs); per phase the
// p25/median/mean of its calls over the build's pages, the median of each over the rounds. Each app is built with the
// checkout it links (`<app>/node_modules/@tiaforge-ui/sinter`): AB_REPO_A / AB_REPO_B override (the checkout whose
// bench/astro/run-sinter.mjs runs the build).
import { spawnSync } from 'node:child_process';
import { readFileSync, realpathSync, rmSync } from 'node:fs';
import { join } from 'node:path';
const [rounds, A, B, ...ph] = process.argv.slice(2);
const phases = ph.length ? ph : ['compile()', 'decideFor', 'settle#1', 'prerender#1', 'prerender#2', 'fileConstants#1', 'fileConstants#2'];
const res = { A: [], B: [] };
for (let r = 0; r < +rounds; r++) for (const [k, app] of [['A', A], ['B', B]]) {
  const f = `/tmp/ab-${process.pid}-${k}.jsonl`; rmSync(f, { force: true });
  const repo = process.env[`AB_REPO_${k}`] ?? realpathSync(join(app, 'node_modules/@tiaforge-ui/sinter'));
  const p = spawnSync(process.execPath, ['--import', join(import.meta.dirname, 'instr.mjs'), `${repo}/bench/astro/run-sinter.mjs`, app], { cwd: repo, encoding: 'utf8', env: { ...process.env, SN_PHASES: f, SN_METHODS: process.env.SN_METHODS ?? 'decideFor,settle,prerender,fileConstants' } });
  const ms = JSON.parse(p.stdout.trim().split('\n').at(-1)).ms;
  const o = JSON.parse(readFileSync(f, 'utf8'));
  res[k].push({ ms, o });
}
const q = (v, x) => { const s = [...v].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(s.length * x))]; };
const med = (v) => q(v, 0.5);
const f2 = (x) => (x === undefined ? '-' : x < 10 ? x.toFixed(2) : x.toFixed(1));
console.log(`build ms: A ${med(res.A.map((x) => x.ms))} B ${med(res.B.map((x) => x.ms))}  (${rounds} rounds)`);
for (const p of phases) {
  const stat = (k) => { const rs = res[k].map((x) => x.o[p]).filter(Boolean); if (!rs.length) return null; return [med(rs.map((v) => q(v, 0.25))), med(rs.map((v) => q(v, 0.5))), med(rs.map((v) => v.reduce((a, b) => a + b, 0) / v.length)), rs[0].length]; };
  const a = stat('A'), b = stat('B'); if (!a) continue;
  console.log(`${p.padEnd(14)} n ${a[3]}  p25/med/mean A ${f2(a[0])} / ${f2(a[1])} / ${f2(a[2])}   B ${f2(b[0])} / ${f2(b[1])} / ${f2(b[2])}`);
}
