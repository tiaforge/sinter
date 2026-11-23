// node --import <this dir>/instr.mjs ...: per-call wall ms (SN_CLOCK=cpu: thread CPU) of the compiler's phases, written at exit to $SN_PHASES (JSON lines)
import { register } from 'node:module';
import { appendFileSync } from 'node:fs';
register('./hooks.mjs', import.meta.url);
const calls = new Map();
const cpu = process.env.SN_CLOCK === "cpu" ? () => { const u = process.threadCpuUsage(); return (u.user + u.system) / 1000; } : () => performance.now();
let depth = new Map();
function wrap(name0, f) {
  return function (...a) {
    const name = name0 === 'compile()' || name0 === 'decideFor' || typeof this?.collecting !== 'function' ? name0 : name0 + (this.collecting() ? '#1' : '#2');
    const d = depth.get(name0) ?? 0;
    if (d) return f.apply(this, a);
    depth.set(name0, 1);
    const t = cpu();
    try { return f.apply(this, a); } finally {
      depth.set(name0, 0);
      let l = calls.get(name); if (!l) calls.set(name, l = []); l.push(cpu() - t);
    }
  };
}
globalThis.__snWrap = wrap;
const METHODS = (process.env.SN_METHODS ?? 'decideFor,settle,prerender,worklist,fileConstants,writtenState').split(',');
globalThis.__snInstr = (C) => {
  for (const m of METHODS) if (C.prototype[m]) C.prototype[m] = wrap(m, C.prototype[m]);
};
process.on('exit', () => { if (globalThis.__snCount) console.error(JSON.stringify(globalThis.__snCount));
  const out = process.env.SN_PHASES;
  const o = Object.fromEntries([...calls].map(([k, v]) => [k, v]));
  if (out) appendFileSync(out, JSON.stringify(o) + '\n');
  else for (const [k, v] of calls) { const s = [...v].sort((a, b) => a - b); console.error(k.padEnd(14), 'n', v.length, 'sum', v.reduce((a, b) => a + b, 0).toFixed(1), 'p25', s[s.length >> 2].toFixed(2), 'med', s[s.length >> 1].toFixed(2)); }
});
