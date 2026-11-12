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
  await expect(run(root, [{ family: 'Source Sans Pro', style: 'italic' }])).rejects.toThrow(/no page's stylesheets \(Google Fonts or the app's own `@font-face`\) have Source Sans Pro 400 italic/);
});

test('without preload, no font preload', async () => {
  const root = project("body { font-family: 'Source Sans Pro'; }");
  await run(root, []);
  expect(readFileSync(join(root, 'dist/index.html'), 'utf8')).not.toContain('as="font"');
});

// A local font (Fontsource's shape: a variable face per subset, files next to the CSS), imported by
// the page's module and bundled by Vite with the woff2 files as hashed assets
const FONTSOURCE = ['latin-ext', 'latin'].map((subset) => `/* figtree-${subset}-wght-normal */
@font-face { font-family: 'Figtree Variable'; font-style: normal; font-display: swap; font-weight: 300 900;
  src: url(./files/figtree-${subset}-wght-normal.woff2) format('woff2-variations');
  unicode-range: ${subset == 'latin' ? 'U+0000-00FF,U+0131,U+0152-0153' : 'U+0100-02BA,U+02BD-02C5'}; }`).join('\n');

function local(styles: string) {
  const root = mkdtempSync(join(tmpdir(), 'sinter-font-local-'));
  dirs.push(root);
  mkdirSync(join(root, 'fonts/files'), { recursive: true });
  writeFileSync(join(root, 'fonts/index.css'), FONTSOURCE);
  // over Vite's inline limit, so each file is an asset
  for (const s of ['latin', 'latin-ext']) writeFileSync(join(root, `fonts/files/figtree-${s}-wght-normal.woff2`), Buffer.alloc(8192, s.length));
  writeFileSync(join(root, 'app.css'), styles);
  writeFileSync(join(root, 'main.ts'), "import './fonts/index.css';\nimport './app.css';\n");
  writeFileSync(join(root, 'index.html'), `<!doctype html><html><head><meta charset="utf-8"><title>t</title>
<script type="module" src="/main.ts"></script>
</head><body data-sn-state="{ n: 1 }"><p data-sn-text="n"></p></body></html>`);
  return root;
}
const runMin = (root: string, preload: FontPreload[]) => build({
  root, logLevel: 'silent', plugins: [sinter({ fonts: { preload } })], resolve: { alias },
  build: { outDir: join(root, 'dist'), emptyOutDir: true },
});

test('a face of the app\'s own @font-face (a local font, minified) preloads its hashed Latin file', async () => {
  const root = local("body { font-family: 'Figtree Variable', sans-serif; }");
  await runMin(root, ['Figtree Variable', { family: 'Figtree Variable', weight: 700 }]);
  const html = readFileSync(join(root, 'dist/index.html'), 'utf8');
  const tags = html.match(/<link rel="preload" as="font"[^>]*>/g) ?? [];
  // one file holds both weights: one preload
  expect(tags).toHaveLength(1);
  expect(tags[0]).toMatch(/^<link rel="preload" as="font" type="font\/woff2" href="\/assets\/figtree-latin-wght-normal-[\w-]+\.woff2" crossorigin>$/);
  // after <meta charset>, before the stylesheet
  expect(html.indexOf('<meta charset="utf-8">')).toBeLessThan(html.indexOf(tags[0]!));
  expect(html.indexOf(tags[0]!)).toBeLessThan(html.indexOf('rel="stylesheet"'));
  const file = /href="\/([^"]+)"/.exec(tags[0]!)![1]!;
  expect(readFileSync(join(root, 'dist', file)).length).toBe(8192);
});

test('a relative base: the local preload is relative to the page, like its stylesheet', async () => {
  const root = local("body { font-family: 'Figtree Variable'; }");
  await build({ root, base: './', logLevel: 'silent', plugins: [sinter({ fonts: { preload: ['Figtree Variable'] } })], resolve: { alias }, build: { outDir: join(root, 'dist'), emptyOutDir: true } });
  const html = readFileSync(join(root, 'dist/index.html'), 'utf8');
  expect(html).toMatch(/<link rel="preload" as="font" type="font\/woff2" href="(\.\/)?assets\/figtree-latin-wght-normal-[\w-]+\.woff2" crossorigin>/);
});

test('a local face the page does not use, or that has no such weight, fails the build', async () => {
  await expect(runMin(local('body { font-family: serif; }'), ['Figtree Variable'])).rejects.toThrow(/preloads Figtree Variable 400, but no stylesheet of the page uses/);
  await expect(runMin(local("body { font-family: 'Figtree Variable'; }"), [{ family: 'Figtree Variable', weight: 200 }])).rejects.toThrow(/have Figtree Variable 200: nothing to preload/);
});
