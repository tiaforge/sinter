// --import mempre.mjs: after each compile(), memory (no forced gc unless MEM_GC=k: every k-th compile, forced, logged as 'gc')
import { register } from 'node:module';
import { writeFileSync } from 'node:fs';
import v8 from 'node:v8';
register('./memhooks.mjs', import.meta.url);
const series = []; let n = 0; const K = +(process.env.MEM_GC ?? 0);
const mb = (x) => +(x / 1048576).toFixed(1);
const rec = (tag) => { const m = process.memoryUsage(); series.push({ n, tag, t: Math.round(performance.now()), heap: mb(m.heapUsed), total: mb(m.heapTotal), ext: mb(m.external), rss: mb(m.rss) }); };
globalThis.__memWrap = (f) => function (...a) { const r = f.apply(this, a); n++; if (K && n % K === 0) { gc(); gc(); rec('gc'); if (process.env.MEM_SNAPN && process.env.MEM_SNAPN.split(",").map(Number).includes(n)) v8.writeHeapSnapshot(process.env.MEM_DIR + `/c${n}.heapsnapshot`); } else rec(''); return r; };
globalThis.__memRec = rec;
process.on('exit', () => { rec('exit'); if (process.env.MEM_OUT) writeFileSync(process.env.MEM_OUT, JSON.stringify(series)); const peak = series.reduce((a, b) => (b.rss > a.rss ? b : a)); console.error('peak sample', JSON.stringify(peak), 'compiles', n, 'maxRSS', Math.round(process.resourceUsage().maxRSS / 1024)); });
