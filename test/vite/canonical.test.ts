// @vitest-environment node
// sinter({ site }) in a build (docs/static-pages.md#canonical-urls): each page's canonical link and $canonical
// from its URL as the build writes it (a directory, a page's declared path, Vite's base); a site with a path refused.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { build } from 'vite';
import { afterAll, expect, test } from 'vitest';
import sinter from '../../src/vite.js';

const src = resolve(__dirname, '../../src');
const alias = [{ find: /^@tiaforge-ui\/sinter\/(.+)$/, replacement: `${src}/$1.ts` }, { find: /^@tiaforge-ui\/sinter$/, replacement: `${src}/index.ts` }];
const root = mkdtempSync(join(tmpdir(), 'sinter-canonical-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const page = (title: string, html = '<html lang="en">') => `<!doctype html>${html}<head><meta charset="utf-8"><title>${title}</title><meta property="og:url" data-sn-attr="{ content: $canonical }"></head><body><p data-sn-text="$site"></p></body></html>`;

test('each page\'s canonical link and $canonical, under a base; $site', async () => {
  const files: Record<string, string> = {
    'index.html': page('Home'),
    'guide/install.html': page('Install'),
    'login.html': page('Sign in', '<html lang="en" data-sn-path="/docs/login">'),
  };
  for (const [f, text] of Object.entries(files)) { mkdirSync(dirname(join(root, f)), { recursive: true }); writeFileSync(join(root, f), text); }
  const out = join(root, 'dist');
  await build({ root, base: '/docs/', logLevel: 'silent', resolve: { alias }, plugins: [sinter({ site: 'https://example.com' })], build: { outDir: out, emptyOutDir: true, rollupOptions: { input: Object.keys(files).map((f) => join(root, f)) } } });
  const at = (f: string) => readFileSync(join(out, f), 'utf8');
  for (const [f, url] of [['index.html', 'https://example.com/docs/'], ['guide/install/index.html', 'https://example.com/docs/guide/install/'], ['login.html', 'https://example.com/docs/login']]) {
    expect(at(f), f).toContain(`<meta property="og:url" content="${url}">`);
    expect(at(f), f).toContain(`<link rel="canonical" href="${url}">`);
    expect(at(f), f).toContain('<p>https://example.com/docs</p>');
  }
});

test('a site with a path is refused: the path is Vite\'s base', () => {
  expect(() => sinter({ site: 'https://example.com/docs' })).toThrow("sinter({ site }): `https://example.com/docs` is not an origin; write it without a path (a site served under a path sets Vite's `base`), e.g. 'https://example.com'");
});
