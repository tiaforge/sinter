// What each implementation makes the browser download (../weight.mjs: JS and CSS on the home page, then with the first
// article, every file gzipped at level 9), with every implementation served as run.mjs serves it: its build from
// setup.mjs, the same local API and the same recorded third-party files (world.mjs).
//   CHROME=/path/to/chrome node weight.mjs [--work dir] [--only a,b] [--sinter label=dir,...]
// --sinter: other sinter builds to measure beside the checkout's (`label=dir`), e.g. one built without its options.
// Needs Playwright (PLAYWRIGHT_FROM=<a file whose node_modules have @playwright/test>, as ../weight.mjs).
import { spawn } from 'node:child_process';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { apps } from './apps.mjs';
import { world } from './world.mjs';

const { values: opt } = parseArgs({ options: { work: { type: 'string', default: join(import.meta.dirname, 'work') }, only: { type: 'string' }, sinter: { type: 'string' } } });
const work = resolve(opt.work);
const w = await world({ dir: work, delay: 150 });
const all = apps(work, w);
for (const s of opt.sinter?.split(',') ?? []) {
  const [label, dist] = s.split('=');
  all[label] = apps(work, w, resolve(dist)).sinter;
}
const names = opt.only ? opt.only.split(',') : Object.keys(all);
const servers = [];
try {
  const args = [];
  for (const n of names) { const s = await all[n](); servers.push(s); args.push(`${n}=${s.url}`); }
  // a child process (asynchronous: the servers answer from this one): ../weight.mjs loads the pages one after another
  const child = spawn(process.execPath, [join(import.meta.dirname, '../weight.mjs'), ...args], { stdio: 'inherit', env: { ...process.env, CHROME_ARGS: JSON.stringify(w.flags) } });
  const code = await new Promise((ok) => child.on('exit', ok));
  if (code) process.exitCode = code;
} finally {
  for (const s of servers) await s.close();
  await w.close();
}
if (w.misses.size) console.error(`not recorded: ${[...w.misses].join(' ')}`);
