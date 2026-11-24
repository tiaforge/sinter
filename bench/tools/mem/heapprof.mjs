// node heapprof.mjs <checkout> <app> <out.json> [interval bytes]: a sampling heap profile over the whole build, collected objects included
import { Session } from 'node:inspector/promises';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
const [repo, root, out, iv = '32768'] = process.argv.slice(2);
const { build } = await import(join(repo, 'node_modules/vite/dist/node/index.js'));
const s = new Session(); s.connect();
await s.post('HeapProfiler.enable');
await s.post('HeapProfiler.startSampling', { samplingInterval: +iv, includeObjectsCollectedByMajorGC: true, includeObjectsCollectedByMinorGC: !process.env.HP_MAJOR_ONLY });
const t0 = performance.now();
await build({ root, configFile: join(root, 'vite.config.js'), logLevel: 'warn' });
const { profile } = await s.post('HeapProfiler.stopSampling');
writeFileSync(out, JSON.stringify(profile));
console.log(JSON.stringify({ ms: Math.round(performance.now() - t0) }));
