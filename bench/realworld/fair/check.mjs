// Loads each implementation's home page once in Chrome under the same flags as run.mjs and checks what it shows:
// the local API's 10 articles, no failed request, no console error. Run it after setup (with --record the first time).
//   CHROME=/path/to/chrome node check.mjs [--work dir] [--record]
// Needs Playwright (PLAYWRIGHT=<path to its index.mjs>, or `playwright` resolvable from here). It drives the CHROME binary:
// some sandboxes give Playwright's own headless shell a network that ignores --host-resolver-rules.
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { apps } from './apps.mjs';
import { world } from './world.mjs';

const { values: opt } = parseArgs({ options: { work: { type: 'string', default: join(import.meta.dirname, 'work') }, record: { type: 'boolean' } } });
const { chromium } = await import(process.env.PLAYWRIGHT ?? 'playwright');
const w = await world({ dir: resolve(opt.work), delay: 150, record: !!opt.record });
const b = await chromium.launch({ args: w.flags, ...(process.env.CHROME ? { executablePath: process.env.CHROME } : {}) });
let ok = true;
try {
  for (const [name, start] of Object.entries(apps(resolve(opt.work), w))) {
    const s = await start(), p = await b.newPage(), bad = [];
    p.on('requestfailed', (r) => bad.push(`failed ${r.url()} ${r.failure()?.errorText}`));
    p.on('response', (r) => r.status() >= 400 && bad.push(`${r.status()} ${r.url()}`));
    p.on('console', (m) => m.type() === 'error' && bad.push(`console: ${m.text().slice(0, 200)}`));
    p.on('pageerror', (e) => bad.push(`page error: ${e.message.slice(0, 200)}`));
    try { await p.goto(s.url, { waitUntil: 'load', timeout: 30000 }); await p.waitForTimeout(3000); } catch (e) { bad.push(e.message.split('\n')[0]); }
    const titles = await p.locator('.article-preview h1').allTextContents().catch(() => []);
    const good = titles.length === 10 && titles[0] === 'How to build article 25' && !bad.length;
    ok &&= good;
    console.log(`${good ? 'ok  ' : 'FAIL'} ${name}: ${titles.length} articles${bad.length ? '\n     ' + bad.join('\n     ') : ''}`);
    await p.close(); await s.close();
  }
} finally { await b.close(); await w.close(); }
if (w.misses.size) { ok = false; console.log(`not recorded: ${[...w.misses].join(' ')}`); }
process.exit(ok ? 0 : 1);
