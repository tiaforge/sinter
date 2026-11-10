// @vitest-environment node
// `sinter({ fonts: { preload } })` in a build: the page preloads the face's Latin file; a preloaded
// family the page's stylesheets do not use, or a face no page has, fails the build. The Google Fonts
// stylesheet comes from the download cache the plugin reads first (no network).
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { build } from 'vite';
import { afterAll, expect, test } from 'vitest';
import sinter from '../../src/vite.js';
import type { FontPreload } from '../../src/fonts-build.js';

const src = resolve(__dirname, '../../src');
const alias = [{ find: '@tiaforge-ui/sinter', replacement: `${src}/index.ts` }];
const GOOGLE = 'https://fonts.googleapis.com/css?family=Source+Sans+Pro:400,700';
const CSS = ['latin-ext', 'latin'].map((subset) => [400, 700].map((w) => `/* ${subset} */
@font-face { font-family: 'Source Sans Pro'; font-style: normal; font-weight: ${w}; src: url(https://fonts.gstatic.com/s/ssp/${subset}-${w}.woff2) format('woff2'); unicode-range: ${subset == 'latin' ? 'U+0000-00FF' : 'U+0100-02BA'}; }`).join('\n')).join('\n');

const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

/** A project with one page linking the Google Fonts stylesheet and `/styles.css` (public) holding `styles`. */
function project(styles: string, extra = '') {
  const root = mkdtempSync(join(tmpdir(), 'sinter-font-preload-'));
  dirs.push(root);
  const cache = join(root, 'node_modules/.cache/sinter/fonts');
  mkdirSync(cache, { recursive: true });
  writeFileSync(join(cache, `${createHash('sha256').update(GOOGLE).digest('hex').slice(0, 24)}.css`), CSS);
  mkdirSync(join(root, 'public'));
  writeFileSync(join(root, 'public/styles.css'), styles);
  writeFileSync(join(root, 'index.html'), `<!doctype html><html><head><meta charset="utf-8"><title>t</title>
<link rel="stylesheet" href="${GOOGLE}">
<link rel="stylesheet" href="/styles.css">${extra}
</head><body data-sn-state="{ n: 1 }"><p data-sn-text="n"></p></body></html>`);
  return root;
}

const run = (root: string, preload: FontPreload[]) => build({
  root, logLevel: 'silent', plugins: [sinter({ fonts: { preload } })], resolve: { alias },
  build: { outDir: join(root, 'dist'), emptyOutDir: true, minify: false },
});

test('a used face is preloaded after <meta charset>: its Latin file, as a CORS font preload', async () => {
  const root = project("body { font-family: 'Source Sans Pro', sans-serif; }");
  await run(root, ['Source Sans Pro', { family: 'Source Sans Pro', weight: 700 }]);
  const html = readFileSync(join(root, 'dist/index.html'), 'utf8');
  expect(html).toContain('<link rel="preload" as="font" type="font/woff2" href="https://fonts.gstatic.com/s/ssp/latin-400.woff2" crossorigin>');
  expect(html).toContain('<link rel="preload" as="font" type="font/woff2" href="https://fonts.gstatic.com/s/ssp/latin-700.woff2" crossorigin>');
  expect(html).not.toContain('latin-ext-');
  expect(html).not.toContain('data-sn-font');
  // the preconnect first, then the preloads
  expect(html.indexOf('rel="preconnect" href="https://fonts.gstatic.com"')).toBeLessThan(html.indexOf('rel="preload" as="font"'));
});

test('a family the page does not use fails the build', async () => {
  const root = project('body { font-family: serif; }');
  await expect(run(root, ['Source Sans Pro'])).rejects.toThrow(/index\.html preloads Source Sans Pro 400, but no stylesheet of the page uses the family `Source Sans Pro`/);
});

test('a family used only in an inline <style> counts as used', async () => {
  await run(project('', '<style>h1 { font: 700 2rem "Source Sans Pro", serif; }</style>'), ['Source Sans Pro']);
});

test('a family used in a stylesheet Vite bundles counts as used; one it bundles without the family does not', async () => {
  const ok = project('', '<link rel="stylesheet" href="/app.css">');
  writeFileSync(join(ok, 'app.css'), "main { font-family: 'Source Sans Pro'; }");
  await run(ok, ['Source Sans Pro']);
  expect(readFileSync(join(ok, 'dist/index.html'), 'utf8')).toMatch(/<link rel="stylesheet"[^>]*href="\/assets\/[^"]+\.css"/);
  const bad = project('', '<link rel="stylesheet" href="/app.css">');
  writeFileSync(join(bad, 'app.css'), 'main { font-family: serif; }');
  await expect(run(bad, ['Source Sans Pro'])).rejects.toThrow(/no stylesheet of the page uses/);
});

test('a face no page has fails the build', async () => {
  const root = project("body { font-family: 'Source Sans Pro'; }");
  await expect(run(root, [{ family: 'Source Sans Pro', style: 'italic' }])).rejects.toThrow(/no page's Google Fonts stylesheets have Source Sans Pro 400 italic/);
});

test('without preload, no font preload', async () => {
  const root = project("body { font-family: 'Source Sans Pro'; }");
  await run(root, []);
  expect(readFileSync(join(root, 'dist/index.html'), 'utf8')).not.toContain('as="font"');
});
