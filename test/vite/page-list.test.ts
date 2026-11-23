// @vitest-environment node
// The build's list of source pages (src/vite.ts `sourceEntries`): every page compile reads it, often several times
// (what other pages request ahead, the Speculation Rules, the swap list). A build keeps it while no new page is added,
// and a compiled page that is already one of its inputs adds none, so making it costs what grows with the pages, not with
// their square; and every page still lists every other.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, expect, test, vi } from 'vitest';

/** the pages `htmlInputs` returned, summed: each fresh list of the source pages starts with it, over every input */
const made = vi.hoisted(() => ({ n: 0 }));
vi.mock('../../src/project.js', async (orig) => {
  const m = await orig<typeof import('../../src/project.js')>();
  return { ...m, htmlInputs: (input: unknown) => { const r = m.htmlInputs(input); made.n += r.length; return r; } };
});
const { build } = await import('vite');
const { default: sinter } = await import('../../src/vite.js');

const src = resolve(__dirname, '../../src');
const alias = [{ find: /^@tiaforge-ui\/sinter\/runtime$/, replacement: `${src}/runtime-entry.ts` }, { find: /^@tiaforge-ui\/sinter\/(?:runtime\/)?([\w-]+)$/, replacement: `${src}/$1.ts` }, { find: /^@tiaforge-ui\/sinter$/, replacement: `${src}/index.ts` }];
const tmp = mkdtempSync(join(tmpdir(), 'sinter-page-list-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

/** a site of `n` pages, each with a request another page's links fetch ahead; the lists made, and one page's HTML */
async function site(n: number) {
  const root = join(tmp, String(n));
  mkdirSync(root, { recursive: true });
  const names = Array.from({ length: n }, (_, i) => `p${i}`);
  for (const p of names) writeFileSync(join(root, `${p}.html`), `<!doctype html><html><head><title>${p}</title></head><body>
<sn-resource name="items" src="/api/${p}" type="any"></sn-resource><p data-sn-text="items ? 'x' : ''"></p><a href="/${p === 'p0' ? 'p1' : 'p0'}/">next</a></body></html>`);
  const before = made.n;
  await build({ root, logLevel: 'silent', resolve: { alias }, plugins: [sinter()], build: { outDir: join(root, 'dist'), emptyOutDir: true, rollupOptions: { input: Object.fromEntries(names.map((p) => [p, join(root, `${p}.html`)])) } } });
  return { made: made.n - before, html: readFileSync(join(root, 'dist/p0/index.html'), 'utf8') };
}

test('the list of source pages costs what grows with the pages, not their square', async () => {
  const small = await site(10), big = await site(40);
  // four times the pages: about four times the work (it was sixteen)
  expect(big.made).toBeLessThan(small.made * 6);
  // every page is in the Speculation Rules of each
  for (let i = 0; i < 40; i++) expect(big.html).toContain(`"/p${i}/\\\\?*#*"`);
}, 120_000);
