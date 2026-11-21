// @vitest-environment node
// Content namespaces (docs/proposals/messages.md §1): a loader's entries called as `ns.id(args)` through the namespace's
// own formatter, per language, folded into the HTML at build over constants, compiled into the page with only the
// entries it calls over data. Nothing here is the built-in messages: the core knows no loader by name.
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { build } from 'vite';
import { afterAll, beforeAll, expect, test } from 'vitest';
import sinter from '../../src/vite.js';

const src = resolve(__dirname, '../../src');
const alias = [{ find: /^@tiaforge-ui\/sinter\/runtime$/, replacement: `${src}/runtime-entry.ts` }, { find: /^@tiaforge-ui\/sinter\/(?:runtime\/)?(.+)$/, replacement: `${src}/$1.ts` }, { find: /^@tiaforge-ui\/sinter$/, replacement: `${src}/index.ts` }];
const root = mkdtempSync(join(tmpdir(), 'sinter-ns-'));
const out = join(root, 'dist');
afterAll(() => rmSync(root, { recursive: true, force: true }));

const files: Record<string, string> = {
  'src/sinter.content.ts': `import { languages, namespace } from '@tiaforge-ui/sinter/content';
export const locales = languages({ base: 'en', list: ['en', 'de'] });
const text = {
  en: [{ id: 'imprint', text: 'Imprint of [shop]' }, { id: 'terms', text: 'Terms, [n] pages' }, { id: 'unused', text: 'Never shipped' }],
  de: [{ id: 'imprint', text: 'Impressum von [shop]' }, { id: 'terms', text: 'AGB, [n] Seiten' }, { id: 'unused', text: 'Nie ausgeliefert' }],
};
export const legal = namespace({ name: 'legal', format: '/src/legal-format.ts', perLocale: true, load: ({ locale }) => text[locale] });
`,
  // the app's own formatter: [name] placeholders, and the language as a suffix
  'src/legal-format.ts': `export function format(entry, args, locale) { return entry.text.replace(/\\[(\\w+)\\]/g, (_, k) => String(args?.[k] ?? '')) + ' (' + locale + ')'; }\n`,
  'index.html': `<!doctype html><html lang="en"><head><title>x</title></head><body>
<sn-resource name="doc" src="/api/doc"></sn-resource>
<h1 data-sn-text="legal.imprint({ shop: 'Acme' })"></h1>
<p data-sn-text="legal.terms({ n: doc.pages })"></p>
</body></html>`,
};
beforeAll(async () => {
  for (const [f, text] of Object.entries(files)) { mkdirSync(dirname(join(root, f)), { recursive: true }); writeFileSync(join(root, f), text); }
  await build({ root, logLevel: 'silent', resolve: { alias }, plugins: [sinter({ localePrefix: true, messages: false, typecheck: false })], build: { outDir: out, emptyOutDir: true, rollupOptions: { input: [join(root, 'index.html')] } } });
}, 120_000);
const read = (f: string) => readFileSync(join(out, f), 'utf8');

test('a call over constants is written into the HTML, in each language, through the app\'s formatter', () => {
  expect(read('en/index.html')).toContain('<h1>Imprint of Acme (en)</h1>');
  expect(read('de/index.html')).toContain('<h1>Impressum von Acme (de)</h1>');
});

test('a call over data is compiled into the page: only the entries it calls, in its language, with the formatter', () => {
  const js = readdirSync(join(out, 'assets')).filter((f) => f.endsWith('.js')).map((f) => readFileSync(join(out, 'assets', f), 'utf8')).join('\n');
  expect(js).toContain('AGB, [n] Seiten');
  expect(js).toContain('Terms, [n] pages');
  expect(js).not.toMatch(/Never shipped|Nie ausgeliefert/);
  // the imprint was folded at build: its entry is not shipped
  expect(js).not.toContain('Impressum von [shop]');
});

test('an unknown entry is SN206, with the namespace\'s ids as suggestions', async () => {
  writeFileSync(join(root, 'bad.html'), '<!doctype html><html><head><title>x</title></head><body><p data-sn-text="legal.imprnt()"></p></body></html>');
  await expect(build({ root, logLevel: 'silent', resolve: { alias }, plugins: [sinter({ localePrefix: true, messages: false, typecheck: false })], build: { outDir: join(root, 'dist-bad'), emptyOutDir: true, rollupOptions: { input: [join(root, 'bad.html')] } } }))
    .rejects.toThrow(/SN206.*`legal\.imprnt` is not exported by namespace `legal`.*imprint/s);
}, 120_000);

test('sinter check and the editor: the namespace\'s ids from the build\'s snapshot', async () => {
  const { snapshotNamespaces } = await import('../../src/content-node.js');
  const { compile } = await import('../../src/compiler/index.js');
  const ns = snapshotNamespaces(root, { module: null, names: [] as string[], namespaces: {} as Record<string, { module: string; members: string[] }> });
  expect(ns.helpers.namespaces.legal).toEqual({ module: 'sinter:content/legal', members: ['imprint', 'terms', 'unused'] });
  const opts = { file: join(root, 'x.html'), root, dev: false, readFile: () => '', helpers: ns.helpers, contentNs: ns.contentNs, check: true };
  expect(compile('<p data-sn-text="legal.terms({ n: 1 })"></p>', opts).diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
  expect(compile('<p data-sn-text="legal.term()"></p>', opts).diagnostics.map((d) => d.code)).toContain('SN206');
});
