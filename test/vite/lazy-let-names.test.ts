// @vitest-environment node
// A let that waits for a lazy helper module (lets.ts, `lazyLet` in compile.ts): only references to a lazy helper
// wait (`$.$z`), not a member or an object key of the same name, nor a callback's parameter; through a real build
// and a browser.
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { build, preview } from 'vite';
import { afterAll, beforeAll, expect, test } from 'vitest';
import sinter from '../../src/vite.js';
import { chromium } from '../browser.js';

const src = resolve(__dirname, '../../src');
const alias = [{ find: /^@tiaforge-ui\/sinter\/runtime$/, replacement: `${src}/runtime-entry.ts` }, { find: /^@tiaforge-ui\/sinter\/(?:runtime\/)?(.+)$/, replacement: `${src}/$1.ts` }, { find: /^@tiaforge-ui\/sinter$/, replacement: `${src}/index.ts` }];
const root = mkdtempSync(join(tmpdir(), 'sinter-lazy-names-'));
const out = join(root, 'dist');
afterAll(() => rmSync(root, { recursive: true, force: true }));
const put = (f: string, s: string) => { mkdirSync(join(root, f, '..'), { recursive: true }); writeFileSync(join(root, f), s); };

// each page: a let, what its <p> shows once the module has arrived
const PAGES: Record<string, [string, string]> = {
  // a call of the helper, over a member of the same name
  call: ["{ t: title(post.title) }", 'T:hello'],
  // no helper call: a member named like the helper
  member: ['{ t: post.title }', 'hello'],
  // an object key named like the helper, beside a call of another
  key: ["{ t: render(post.title), o: { title: post.title } }", 'R:hello|hello'],
  // a callback's parameter named like the helper
  param: ["{ t: xs.map((title) => title + '!').join() }", 'a!,b!'],
  // a shorthand key is a reference: it waits
  short: ['{ o: { title } }', 'function'],
};
const SHOWN: Record<string, string> = { call: 't', member: 't', key: "t + '|' + o.title", param: 't', short: 'typeof o?.title' };

beforeAll(async () => {
  put('node_modules/fakepgp/package.json', JSON.stringify({ name: 'fakepgp', version: '1.0.0', type: 'module', main: 'index.js' }));
  put('node_modules/fakepgp/index.js', 'export const up = (s) => s;\n');
  put('src/sinter.helpers.ts', `export { title, render } from './lib/md.ts';\n`);
  put('src/lib/md.ts', `import { up } from 'fakepgp';\nexport function title(s: string) { return 'T:' + up(s); }\nexport function render(s: string) { return 'R:' + up(s); }\n`);
  const input: Record<string, string> = {};
  for (const [name, [lets]] of Object.entries(PAGES)) {
    put(`${name}.html`, `<!doctype html><html><head><title>${name}</title></head><body>
<main data-sn-state="{ post: { title: 'hello' }, xs: ['a', 'b'] }" data-sn-let="${lets}"><p id="out" data-sn-text="${SHOWN[name]}"></p></main>
</body></html>`);
    input[name] = join(root, `${name}.html`);
  }
  await build({ root, logLevel: 'silent', plugins: [sinter({ lazy: ['fakepgp'] })], resolve: { alias }, build: { outDir: out, emptyOutDir: true, minify: false, rollupOptions: { input } } });
}, 120_000);

const code = () => readdirSync(join(out, 'assets')).filter((f) => f.endsWith('.js')).map((f) => readFileSync(join(out, 'assets', f), 'utf8')).join('\n');

test('the build: no member, key or parameter rewritten', () => {
  const js = code();
  expect(js).not.toMatch(/\.\$\.\$z\(/);
  expect(js).not.toMatch(/\{ ?\$\.\$z\(/);
  expect(js).not.toMatch(/\(\$\.\$z\(\d+, "title"\)\) =>/);
  // the member-only page waits for nothing
  expect(js).toContain('$.$z(0, "title")');
});

test.skipIf(!chromium)('in the browser: each page shows its value once the module has arrived', async () => {
  const server = await preview({ root, logLevel: 'silent', preview: { port: 0 }, build: { outDir: out } });
  const browser = await chromium!.launch();
  try {
    const tab = await browser.newPage();
    const errors: string[] = [];
    tab.on('pageerror', (e) => errors.push(e.message));
    for (const [name, [, want]] of Object.entries(PAGES)) {
      await tab.goto(server.resolvedUrls!.local[0]! + `${name}/`);
      await tab.waitForFunction((w) => document.querySelector('#out')?.textContent === w, want, { timeout: 10_000 }).catch(() => {});
      expect(`${name}: ${await tab.textContent('#out')}`).toBe(`${name}: ${want}`);
    }
    expect(errors).toEqual([]);
  } finally {
    await browser.close();
    await new Promise((r) => server.httpServer.close(r));
  }
}, 60_000);
