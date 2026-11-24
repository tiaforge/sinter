// @vitest-environment node
// The fold check's analyses kept on disk (src/fold-check.ts, `FoldCache.dir`): a module's analysis is kept by its path,
// its text and the analysis's version, and read by the next process instead of parsing the module again. The verdicts
// must be the same with no cache, a cold one and a warm one; the cache is never an error.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, expect, test } from 'vitest';
import { FoldCache, foldVerdicts } from '../src/fold-check.js';
import { readHelperManifest } from '../src/compiler/index.js';

const tmp = mkdtempSync(join(tmpdir(), 'sinter-fold-cache-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));
let n = 0;

/** an app with helpers that fold and that do not, through imports, a namespace, a package, JSON and a broken module */
function app() {
  const root = join(tmp, `app-${n++}`);
  const put = (f: string, s: string) => { mkdirSync(join(root, f, '..'), { recursive: true }); writeFileSync(join(root, f), s); };
  put('src/sinter.helpers.ts', `export * as fmt from './lib/fmt.ts';
export { slug, viaPkg, data } from './lib/text.ts';
export { broken } from './lib/broken.ts';
export const upper = (s: string): string => s.toUpperCase();
export function stamp(): number { return Date.now(); }
`);
  put('src/lib/fmt.ts', `const digits = { short: 2 };
function round(n: number) { return Math.round(n * 100) / 100; }
export function price(n: number) { return round(n).toFixed(digits.short); }
export function chance() { return Math.random(); }
let count = 0;
export function next() { return count++; }
`);
  put('src/lib/text.ts', `import { clean } from './clean.ts';
import plain from 'fakelib';
import table from './table.json';
export function slug(s: string) { return clean(s).toLowerCase().replace(/[^a-z]+/g, '-'); }
export function viaPkg(s: string) { return plain(s); }
export function data(k: string) { return (table as Record<string, string>)[k]; }
`);
  put('src/lib/clean.ts', 'export const clean = (s: string) => s.trim();\n');
  put('src/lib/table.json', '{ "a": "b" }');
  put('src/lib/broken.ts', 'export function broken( { return 1 }\n');
  put('node_modules/fakelib/package.json', JSON.stringify({ name: 'fakelib', type: 'module', exports: { '.': { production: './plain.js', default: './dev.js' } } }));
  put('node_modules/fakelib/plain.js', 'export default (s) => s;\n');
  const helpers = join(root, 'src/sinter.helpers.ts');
  const verdicts = (cache: FoldCache) => [...foldVerdicts(readHelperManifest(readFileSync(helpers, 'utf8'), { module: '/src/sinter.helpers.ts', file: helpers, readFile: (f) => readFileSync(f, 'utf8') }), root, helpers, cache)];
  return { root, put, verdicts, dir: join(root, 'node_modules/.cache/sinter/fold') };
}
const kept = (dir: string) => (existsSync(dir) ? readdirSync(dir).map((f) => join(dir, f)) : []);
const cached = (dir: string, fresh = false) => { const c = new FoldCache(); c.dir = dir; c.fresh = fresh; return c; };
/** the kept analysis of a module, by the file it names */
const entryOf = (dir: string, file: string) => kept(dir).find((f) => JSON.parse(readFileSync(f, 'utf8')).file === file)!;

test('the same verdicts, positions and chains with no cache, a cold cache and a warm one', () => {
  const a = app();
  const none = a.verdicts(new FoldCache());
  expect(kept(a.dir)).toEqual([]);
  const cold = a.verdicts(cached(a.dir));
  // one analysis a module: the helpers, fmt, text, clean, the JSON, the package's, the broken one
  expect(kept(a.dir).length).toBe(7);
  const warm = a.verdicts(cached(a.dir));
  expect(cold).toEqual(none);
  expect(warm).toEqual(none);
  // the verdicts are of every kind: folds, a global, a module binding assigned, a package, a broken module
  const by = Object.fromEntries(none);
  expect(by.upper).toEqual({ fold: true });
  expect(by.slug).toEqual({ fold: true });
  expect(by.data).toEqual({ fold: true });
  expect(by.stamp.fold).toBe(false);
  expect(by.fmt$next.fold).toBe(false);
  expect(by.broken.fold).toBe(false);
});

test('kept by the text, not by mtime and size: an edit of the same size with the old mtime is analysed again', () => {
  const a = app();
  a.verdicts(cached(a.dir));
  const f = join(a.root, 'src/lib/clean.ts'), was = statSync(f);
  // as long as before, and dated as before
  a.put('src/lib/clean.ts', 'export const clean = (s: string) => s + Date.now();\n'.slice(0, was.size).padEnd(was.size, ' '));
  expect(statSync(f).size).toBe(was.size);
  utimesSync(f, was.atime, was.mtime);
  const v = Object.fromEntries(a.verdicts(cached(a.dir)));
  expect(v.slug.fold).toBe(false);
  expect(Object.fromEntries(a.verdicts(new FoldCache()))).toEqual(v);
});

test('an imported module edited: its verdict follows, the importer\'s analysis is read as kept', () => {
  const a = app();
  a.verdicts(cached(a.dir));
  const text = entryOf(a.dir, join(a.root, 'src/lib/text.ts')), before = readFileSync(text, 'utf8');
  a.put('src/lib/clean.ts', 'export const clean = (s: string) => s + Math.random();\n');
  const v = Object.fromEntries(a.verdicts(cached(a.dir)));
  expect(v.slug).toMatchObject({ fold: false });
  expect(v).toEqual(Object.fromEntries(a.verdicts(new FoldCache())));
  expect(readFileSync(text, 'utf8')).toBe(before);
});

test('a kept analysis is read: one changed on disk shows; not under `fresh` (`vite --force`), nor under another version', () => {
  const a = app();
  const good = a.verdicts(cached(a.dir));
  const f = entryOf(a.dir, join(a.root, 'src/sinter.helpers.ts'));
  const k = JSON.parse(readFileSync(f, 'utf8'));
  // the unit of `upper` marked as reading something: a warm cache reads it (so it is the analysis, not a parse, that answers)
  const unit = k.info.units.find(([name]: [string]) => name === 'upper')[1];
  unit.bad = { reason: '`planted`', at: 0 };
  writeFileSync(f, JSON.stringify(k));
  expect(Object.fromEntries(a.verdicts(cached(a.dir))).upper).toMatchObject({ fold: false, reason: '`planted`' });
  // `fresh`: not read, and written again
  expect(a.verdicts(cached(a.dir, true))).toEqual(good);
  expect(a.verdicts(cached(a.dir))).toEqual(good);
  // another version of the analysis: not read
  const k2 = JSON.parse(readFileSync(f, 'utf8'));
  k2.info.units.find(([name]: [string]) => name === 'upper')[1].bad = { reason: '`planted`', at: 0 };
  k2.v = 'another';
  writeFileSync(f, JSON.stringify(k2));
  expect(a.verdicts(cached(a.dir))).toEqual(good);
});

test('a corrupt, truncated or foreign file is ignored and written again, never an error', () => {
  const a = app();
  const good = a.verdicts(cached(a.dir));
  const files = kept(a.dir);
  writeFileSync(files[0]!, readFileSync(files[0]!, 'utf8').slice(0, 40));
  writeFileSync(files[1]!, 'not json');
  writeFileSync(files[2]!, JSON.stringify({ v: 1, info: { units: 'x' } }));
  writeFileSync(files[3]!, '');
  expect(a.verdicts(cached(a.dir))).toEqual(good);
  for (const f of kept(a.dir)) expect(() => JSON.parse(readFileSync(f, 'utf8'))).not.toThrow();
  expect(a.verdicts(cached(a.dir))).toEqual(good);
});

test('a folder that cannot be made or written: the same verdicts, silently', () => {
  const a = app();
  const good = a.verdicts(new FoldCache());
  // its parent is a file
  writeFileSync(join(a.root, 'node_modules/.cache-file'), 'x');
  expect(a.verdicts(cached(join(a.root, 'node_modules/.cache-file/sinter/fold')))).toEqual(good);
});

const dist = resolve(__dirname, '../dist/fold-check.js');
test.skipIf(!existsSync(dist))('builds writing at once: every kept file reads whole (a write is a rename), no temporary files left', async () => {
  const a = app();
  // four processes analysing the same modules again and again (`fresh`: every time written), while this one reads
  const child = `import { FoldCache, foldVerdicts } from ${JSON.stringify(dist)};
import { readHelperManifest } from ${JSON.stringify(resolve(__dirname, '../dist/compiler/index.js'))};
import { readFileSync } from 'node:fs';
const [root, dir] = process.argv.slice(1), helpers = root + '/src/sinter.helpers.ts';
for (let i = 0; i < 40; i++) { const c = new FoldCache(); c.dir = dir; c.fresh = true; foldVerdicts(readHelperManifest(readFileSync(helpers, 'utf8'), { module: '/src/sinter.helpers.ts', file: helpers, readFile: (f) => readFileSync(f, 'utf8') }), root, helpers, c); }`;
  const runs = Array.from({ length: 4 }, () => new Promise<number>((ok) => spawn(process.execPath, ['--input-type=module', '-e', child, a.root, a.dir], { stdio: 'ignore' }).on('exit', (code) => ok(code ?? 1))));
  let reads = 0, done = false;
  void Promise.all(runs).then(() => { done = true; });
  while (!done) {
    for (const f of kept(a.dir)) {
      if (f.endsWith('.tmp')) continue;
      let text = '';
      try { text = readFileSync(f, 'utf8'); } catch { continue; }
      expect(() => JSON.parse(text), f).not.toThrow();
      reads++;
    }
    await new Promise((r) => setTimeout(r, 2));
  }
  expect(await Promise.all(runs)).toEqual([0, 0, 0, 0]);
  expect(reads).toBeGreaterThan(0);
  expect(kept(a.dir).filter((f) => f.endsWith('.tmp'))).toEqual([]);
  expect(a.verdicts(cached(a.dir))).toEqual(a.verdicts(new FoldCache()));
}, 120_000);
