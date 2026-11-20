// @vitest-environment node
// The build's pages: every `.html` under the root, as the dev server serves them, without an input in the config;
// the components' and layouts' folders, `public/`, the output and `node_modules` are not pages.
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { build } from 'vite';
import { afterAll, expect, test } from 'vitest';
import sinter from '../../src/vite.js';

const src = resolve(__dirname, '../../src');
const alias = [{ find: /^@tiaforge-ui\/sinter\/runtime$/, replacement: `${src}/runtime-entry.ts` }, { find: /^@tiaforge-ui\/sinter\/(?:runtime\/)?(.+)$/, replacement: `${src}/$1.ts` }, { find: /^@tiaforge-ui\/sinter$/, replacement: `${src}/index.ts` }];
const tmp = mkdtempSync(join(tmpdir(), 'sinter-input-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

test('without an input, every page under the root is built, and the app is a multi-page app', async () => {
  const root = join(tmp, 'app');
  const files: Record<string, string> = {
    'index.html': '<p data-sn-state="{ n: 1 }" data-sn-text="n"></p>',
    'docs/guide.html': '<p>guide</p>',
    'src/components/x-card.html': '<template data-sn-props=""><div></div></template>',
    'public/static.html': '<p>copied as is</p>',
  };
  for (const [f, s] of Object.entries(files)) { mkdirSync(join(root, f, '..'), { recursive: true }); writeFileSync(join(root, f), s); }
  const out = join(root, 'dist');
  let appType: string | undefined;
  await build({ root, logLevel: 'silent', resolve: { alias }, build: { outDir: out, emptyOutDir: true },
    plugins: [sinter({ images: false }), { name: 'probe', configResolved(c) { appType = c.appType; } }] });
  expect(appType).toBe('mpa');
  const html = (d: string): string[] => readdirSync(d, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? html(join(d, e.name)).map((f) => `${e.name}/${f}`) : e.name.endsWith('.html') ? [e.name] : []);
  // docs/guide/index.html: the page at its clean URL too; static.html: public/, copied as is
  expect(html(out).sort()).toEqual(['docs/guide.html', 'docs/guide/index.html', 'index.html', 'static.html']);
});
