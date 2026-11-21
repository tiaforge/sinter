// Compile timings for docs/proposals/axes.md (step 0): the app of app.mjs at each number of languages and tenants,
// with and without the linker (SN_NO_LINK), each build in a fresh process (../collections/run.mjs). Tenants are
// built the way an app does it today, one `vite build` per tenant; the time is their sum.
// node bench/axes/measure.mjs [--pages 50] [--posts 10] [--langs 1,2,10] [--tenants 1,20]
import { execFileSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { writeApp } from './app.mjs';

const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const pages = Number(arg('--pages', '50'));
const posts = Number(arg('--posts', '10'));
const langsList = arg('--langs', '1,2,10').split(',').map(Number);
const tenantsList = arg('--tenants', '1,20').split(',').map(Number);
const out = resolve(import.meta.dirname, 'out');
const run = join(import.meta.dirname, '../collections/run.mjs');
const rows = [];
for (const langs of langsList) {
  const root = join(out, `l${langs}`);
  writeApp(root, { pages, posts, langs });
  for (const tenants of tenantsList) for (const link of [true, false]) {
    rmSync(join(root, 'dist'), { recursive: true, force: true });
    let ms = 0, maxRssMb = 0, html = 0, error = null;
    for (let t = 0; t < tenants && !error; t++) {
      const env = { ...process.env, TENANT: `t${t}`, ...(link ? {} : { SN_NO_LINK: '1' }) };
      const r = JSON.parse(execFileSync(process.execPath, [run, root], { encoding: 'utf8', env, maxBuffer: 1 << 26 }).trim().split('\n').pop());
      ms += r.ms; maxRssMb = Math.max(maxRssMb, r.maxRssMb); error = r.error;
      if (t === 0) html = r.html;
    }
    const points = (pages + 1 + posts) * langs * tenants;
    rows.push({ langs, tenants, linker: link, points, ms, msPerPoint: +(ms / points).toFixed(1), maxRssMb, htmlPerTenant: html, error });
    console.log(JSON.stringify(rows.at(-1)));
  }
}
console.table(rows.map(({ error, ...r }) => r));
