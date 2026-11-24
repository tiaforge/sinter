// node --expose-gc memrun.mjs <checkout> <app> : one build with a probe plugin; memory after a forced gc at points.
// MEM_SNAP=point1,point2 writes heap snapshots there (to MEM_DIR). MEM_NOGC=1: no forced gc (raw).
import { join } from 'node:path';
import v8 from 'node:v8';
const [repo, root] = process.argv.slice(2);
const { build } = await import(join(repo, 'node_modules/vite/dist/node/index.js'));
const snap = new Set((process.env.MEM_SNAP ?? '').split(',').filter(Boolean));
const rows = []; const { smaps } = await import('./smaps.mjs'); const sm = {};
const mb = (x) => +(x / 1048576).toFixed(1);
function point(name) {
  if (!process.env.MEM_NOGC) { globalThis.gc(); globalThis.gc(); }
  const m = process.memoryUsage(), h = v8.getHeapStatistics();
  rows.push({ point: name, heap: mb(m.heapUsed), heapTotal: mb(m.heapTotal), ext: mb(m.external), ab: mb(m.arrayBuffers), rss: mb(m.rss), malloced: mb(h.malloced_memory), peakMalloc: mb(h.peak_malloced_memory) });
  if (process.env.MEM_SMAPS) sm[name] = smaps(); if (snap.has(name)) v8.writeHeapSnapshot(join(process.env.MEM_DIR ?? '/tmp', `${name}.heapsnapshot`));
}
let nT = 0;
const probe = (order) => ({
  name: 'mem-probe-' + order, enforce: order,
  buildStart() { if (order === 'post') point('buildStart'); },
  transform(code, id) { if (order === 'post' && id.endsWith('.html')) { nT++; if (nT % 100 === 0) point('html' + nT); } },
  buildEnd() { if (order === 'pre') point('buildEnd-pre'); else point('buildEnd-post'); },
  renderStart() { if (order === 'post') point('renderStart'); },
  generateBundle: order === 'pre' ? { order: 'pre', handler() { point('genBundle-pre'); } } : { order: 'post', handler() { point('genBundle-post'); } },
  writeBundle() { if (order === 'post') point('writeBundle'); },
  closeBundle() { if (order === 'post') point('closeBundle'); },
});
point('start');
const t0 = performance.now();
await build({ root, configFile: join(root, 'vite.config.js'), logLevel: 'warn', plugins: [probe('pre'), probe('post')] });
const ms = Math.round(performance.now() - t0);
point('end');
console.table(rows); if (process.env.MEM_SMAPS) console.table(sm);
console.log(JSON.stringify({ ms, maxRssMb: Math.round(process.resourceUsage().maxRSS / 1024) }));
