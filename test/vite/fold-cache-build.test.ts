// @vitest-environment node
// A build keeps the fold check's analyses in node_modules/.cache/sinter/fold (src/fold-check.ts `FoldCache.dir`), not
// in this suite unless a test asks (`SN_FOLD_CACHE=1`). The output and the log are the same with no cache, a cold one
// and a warm one.
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { build, createLogger } from 'vite';
import { afterAll, afterEach, expect, test } from 'vitest';
import sinter from '../../src/vite.js';

const src = resolve(__dirname, '../../src');
const alias = [{ find: /^@tiaforge-ui\/sinter\/runtime$/, replacement: `${src}/runtime-entry.ts` }, { find: /^@tiaforge-ui\/sinter\/(?:runtime\/)?(.+)$/, replacement: `${src}/$1.ts` }, { find: /^@tiaforge-ui\/sinter$/, replacement: `${src}/index.ts` }];
const tmp = mkdtempSync(join(tmpdir(), 'sinter-fold-cache-build-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));
afterEach(() => { delete process.env.SN_FOLD_CACHE; });
const walk = (d: string): string[] => readdirSync(d).flatMap((f) => (statSync(join(d, f)).isDirectory() ? walk(join(d, f)) : [join(d, f)]));

const root = join(tmp, 'app');
mkdirSync(join(root, 'src/lib'), { recursive: true });
writeFileSync(join(root, 'src/sinter.helpers.ts'), "export { slug } from './lib/slug.ts';\nexport const stamp = (s: string) => s + Date.now();\n");
writeFileSync(join(root, 'src/lib/slug.ts'), "export const slug = (s: string) => s.trim().toLowerCase().replace(/[^a-z]+/g, '-');\n");
writeFileSync(join(root, 'index.html'), `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>t</title></head><body>
<p data-sn-text="slug(' Hello World ')"></p><p data-sn-text="stamp('x')"></p></body></html>`);
const cacheDir = join(root, 'node_modules/.cache/sinter/fold');

async function run(out: string) {
  const lines: string[] = [], logger = createLogger('info');
  for (const k of ['info', 'warn', 'warnOnce', 'error'] as const) logger[k] = (m: string) => { lines.push(`${k} ${m.replaceAll(join(tmp, out), 'OUT').replaceAll(relative(root, join(tmp, out)), 'OUT').replace(/\d+(\.\d+)? ?m?s\b/g, 'T')}`); };
  await build({ root, customLogger: logger, resolve: { alias }, plugins: [sinter()], build: { outDir: join(tmp, out), emptyOutDir: true } });
  const files = Object.fromEntries(walk(join(tmp, out)).map((f) => [relative(join(tmp, out), f), readFileSync(f, 'utf8')]));
  return { files, lines: lines.sort() };
}

test('no cache in this suite; asked for, the same build cold and warm', async () => {
  const none = await run('none');
  expect(existsSync(cacheDir)).toBe(false);
  process.env.SN_FOLD_CACHE = '1';
  const cold = await run('cold');
  expect(readdirSync(cacheDir).length).toBe(2);
  const warm = await run('warm');
  expect(cold).toEqual(none);
  expect(warm).toEqual(none);
  // the helper that folds is written into the page, the one that reads the clock stays in the browser
  expect(none.files['index.html']).toContain('<p>hello-world</p>');
  expect(none.files['index.html']).not.toContain('<p>x');
  process.env.SN_FOLD_CACHE = '0';
  rmSync(cacheDir, { recursive: true });
  expect(await run('off')).toEqual(none);
  expect(existsSync(cacheDir)).toBe(false);
}, 120_000);
