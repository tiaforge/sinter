// @vitest-environment node
// memo() at build time (src/memo.ts): a memoized helper folds as the function it calls does, its cache being the
// memo's own (state in its closure, none at the module's top level); the build's cross-check still finds state
// a memoized function keeps between calls.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { build } from 'vite';
import { afterAll, expect, test } from 'vitest';
import sinter from '../../src/vite.js';
import { loadHelpers } from '../../src/helpers-node.js';
import { readHelperManifest } from '../../src/compiler/index.js';

const src = resolve(__dirname, '../../src');
const alias = [{ find: /^@tiaforge-ui\/sinter\/(.+)$/, replacement: `${src}/$1.ts` }, { find: /^@tiaforge-ui\/sinter$/, replacement: `${src}/index.ts` }];
const tmp = mkdtempSync(join(tmpdir(), 'sinter-memo-fold-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

let n = 0;
function app(helpers: string, pages: string[]) {
  const root = join(tmp, `app-${n++}`);
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(join(root, 'src/sinter.helpers.ts'), helpers);
  const input: Record<string, string> = {};
  pages.forEach((body, i) => { writeFileSync(join(root, `p${i}.html`), `<!doctype html><html><head><title>p</title></head><body><main>${body}</main></body></html>`); input[`p${i}`] = join(root, `p${i}.html`); });
  return { root, input };
}
const HELPERS = `import { memo } from '@tiaforge-ui/sinter/memo';
function words(s: string) { return s.split(' ').map((w) => ({ w })); }
export const split = memo(words);
export const count = memo((s: string, o: { min: number }) => s.split(' ').filter((w) => w.length >= o.min).length, { maxSize: 1024 });
`;

test('the fold check: a memoized helper folds when the function it calls does', async () => {
  const { root } = app(HELPERS + `export const now = memo(() => Date.now());\n`, []);
  const file = join(root, 'src/sinter.helpers.ts');
  const manifest = readHelperManifest(readFileSync(file, 'utf8'), { module: '/src/sinter.helpers.ts', file, readFile: (f) => readFileSync(f, 'utf8') });
  const h = await loadHelpers({ root, helpersFile: file, manifest, alias });
  expect(h.error).toBeNull();
  expect(h.fold.get('split')).toEqual({ fold: true });
  expect(h.fold.get('count')).toEqual({ fold: true });
  // what the function it calls reads decides
  expect(h.fold.get('now')?.fold).toBe(false);
}, 60_000);

test('a build folds memoized helpers into the page', async () => {
  const { root, input } = app(HELPERS, ['<p data-sn-text="split(\'a bb c\').length + \':\' + count(\'a bb ccc\', { min: 2 })"></p>']);
  await build({ root, logLevel: 'silent', plugins: [sinter({ static: true })], resolve: { alias }, build: { outDir: join(root, 'dist'), emptyOutDir: true, rollupOptions: { input } } });
  expect(readFileSync(join(root, 'dist/p0/index.html'), 'utf8')).toContain('<p>3:2</p>');
}, 120_000);

test('the cross-check: state a memoized function keeps between calls fails the build (SN534)', async () => {
  const { root, input } = app(`import { memo } from '@tiaforge-ui/sinter/memo';\nconst st = { n: 0 };\nexport const idOf = memo((s: string) => ++st.n);\n`,
    ['<p data-sn-text="idOf(\'a\')"></p>', '<p data-sn-text="idOf(\'b\')"></p>', '<p data-sn-text="idOf(\'c\')"></p>']);
  let error = '';
  try { await build({ root, logLevel: 'silent', plugins: [sinter({ static: true })], resolve: { alias }, build: { outDir: join(root, 'dist'), emptyOutDir: true, rollupOptions: { input } } }); } catch (e) { error = (e as Error).message; }
  expect(error).toMatch(/SN534 helper-not-folded: idOf\(\) gave other results/);
}, 120_000);
