// @vitest-environment node
// Speculation Rules and same-page links (docs/navigation.md#same-page-links): a page that loads
// query-links leaves out its own URLs with another query; inline, each page's rules have their hash
// (the build names every one); delivered by a header, the one file leaves them out once a page does.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { build, createLogger } from 'vite';
import { afterAll, beforeAll, expect, test } from 'vitest';
import sinter from '../../src/vite.js';

const src = resolve(__dirname, '../../src');
const alias = [{ find: /^@tiaforge-ui\/sinter\/(.+)$/, replacement: `${src}/$1.ts` }, { find: /^@tiaforge-ui\/sinter$/, replacement: `${src}/index.ts` }];
const dir = mkdtempSync(join(tmpdir(), 'sinter-same-page-rules-'));
const root = join(dir, 'app');
const page = (body: string) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>t</title></head><body>${body}</body></html>`;
const rulesOf = (html: string) => JSON.parse(/<script type="speculationrules">(.*?)<\/script>/.exec(html)![1]!);
const EXCLUDE = { not: { href_matches: '?*', relative_to: 'document' } };

beforeAll(() => {
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, 'index.html'), page('<p data-sn-text="$url.q ?? \'-\'"></p><a href="?q=1">1</a><a href="/other/">other</a>'));
  writeFileSync(join(root, 'other.html'), page('<p data-sn-text="$url.q ?? \'-\'"></p><a href="/">home</a>'));
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

test('inline: the page with same-page links leaves out its own URLs; the build names both hashes', async () => {
  const lines: string[] = [], logger = createLogger('silent');
  logger.info = (m: string) => { lines.push(m); };
  const out = join(dir, 'inline');
  await build({ root, customLogger: logger, resolve: { alias }, build: { outDir: out, emptyOutDir: true, minify: false, rollupOptions: { input: [join(root, 'index.html'), join(root, 'other.html')] } }, plugins: [sinter()] });
  const home = rulesOf(readFileSync(join(out, 'index.html'), 'utf8')), other = rulesOf(readFileSync(join(out, 'other', 'index.html'), 'utf8'));
  expect(home.prefetch[0].where.and).toContainEqual(EXCLUDE);
  expect(other.prefetch[0].where.and).not.toContainEqual(EXCLUDE);
  const hint = lines.find((l) => l.includes('Speculation Rules are inline'))!;
  expect(hint.match(/'sha256-[^']+'/g)).toHaveLength(2);
});

test('header: one rules file, which leaves out each page\'s own URLs once a page has same-page links', async () => {
  const out = join(dir, 'header');
  await build({ root, logLevel: 'silent', resolve: { alias }, build: { outDir: out, emptyOutDir: true, minify: false, rollupOptions: { input: [join(root, 'index.html'), join(root, 'other.html')] } }, plugins: [sinter({ speculation: { mode: 'prefetch', delivery: 'header' } })] });
  expect(JSON.parse(readFileSync(join(out, 'speculation-rules.json'), 'utf8')).prefetch[0].where.and).toContainEqual(EXCLUDE);
});
