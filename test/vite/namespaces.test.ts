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

test('the messages as a namespace: inlang() with nested keys, plurals and the chain, through the messages formatter', async () => {
  const app = mkdtempSync(join(tmpdir(), 'sinter-inlang-'));
  try {
    const f: Record<string, string> = {
      'project.inlang/settings.json': JSON.stringify({ baseLocale: 'en', locales: ['en', 'de', 'de-AT'], 'plugin.inlang.messageFormat': { pathPattern: './messages/{locale}.json' } }),
      'messages/en.json': JSON.stringify({ inbox: { title: 'Inbox', unread: [{ declarations: ['input count', 'local n = count: plural'], selectors: ['n'], match: { 'n=one': '{count} unread message', 'n=*': '{count} unread messages' } }] } }),
      'messages/de.json': JSON.stringify({ inbox: { title: 'Posteingang', unread: [{ declarations: ['input count', 'local n = count: plural'], selectors: ['n'], match: { 'n=one': '{count} ungelesene Nachricht', 'n=*': '{count} ungelesene Nachrichten' } }] } }),
      'messages/de-AT.json': JSON.stringify({ inbox: { title: 'Eingang' } }),
      'src/sinter.content.ts': `import { languages } from '@tiaforge-ui/sinter/content';
import { inlang, inlangLocales } from '@tiaforge-ui/sinter/messages/content';
export const locales = languages(inlangLocales('project.inlang', ${JSON.stringify(app)}));
export const messages = inlang();
`,
      // app code calls the messages through the module, nested
      'src/sinter.helpers.ts': `import { m } from '@tiaforge-ui/sinter/messages';\nexport const shout = (n: number) => m.inbox.title().toUpperCase() + ' ' + n;\n`,
      'index.html': `<!doctype html><html lang="en"><head><title>x</title></head><body><sn-resource name="inbox" src="/api/inbox"></sn-resource>
<h1 data-sn-text="m.inbox.title()"></h1><p data-sn-text="m.inbox.unread({ count: 1 })"></p><b data-sn-text="m.inbox.unread({ count: inbox.n })"></b><i data-sn-text="shout(inbox.n)"></i></body></html>`,
    };
    for (const [k, v] of Object.entries(f)) { mkdirSync(dirname(join(app, k)), { recursive: true }); writeFileSync(join(app, k), v); }
    const dist = join(app, 'dist');
    await build({ root: app, logLevel: 'silent', resolve: { alias }, plugins: [sinter({ localePrefix: true, messages: false, typecheck: false })], build: { outDir: dist, emptyOutDir: true, rollupOptions: { input: [join(app, 'index.html')] } } });
    const page = (l: string) => readFileSync(join(dist, l, 'index.html'), 'utf8');
    expect(page('en')).toMatch(/<h1>Inbox<\/h1><p>1 unread message<\/p>/);
    expect(page('de')).toMatch(/<h1>Posteingang<\/h1><p>1 ungelesene Nachricht<\/p>/);
    // de-AT has its own title, and de's plural (its chain)
    expect(page('de-AT')).toMatch(/<h1>Eingang<\/h1><p>1 ungelesene Nachricht<\/p>/);
    // the one over data: compiled with the messages formatter and its message alone
    const js = readdirSync(join(dist, 'assets')).filter((x) => x.endsWith('.js')).map((x) => readFileSync(join(dist, 'assets', x), 'utf8')).join('\n');
    expect(js).toContain('ungelesene Nachrichten');
    // the message the helper calls: written into the German page, in German, with its language
    expect(page('de')).toContain('<script type="application/json" data-sn-ns="m" lang="de">{"inbox.title":"Posteingang"}</script>');
  } finally {
    rmSync(app, { recursive: true, force: true });
  }
}, 120_000);

test('what a page ships of the messages: nothing without a call; the module alone for plain texts; the formatter for a plural', async () => {
  const app = mkdtempSync(join(tmpdir(), 'sinter-inlang-ship-'));
  try {
    const plural = (one: string, other: string) => [{ declarations: ['input count', 'local n = count: plural'], selectors: ['n'], match: { 'n=one': one, 'n=*': other } }];
    const page = (body: string) => `<!doctype html><html lang="en"><head><title>x</title></head><body><sn-resource name="d" src="/api/d"></sn-resource>${body}</body></html>`;
    const f: Record<string, string> = {
      'project.inlang/settings.json': JSON.stringify({ baseLocale: 'en', locales: ['en', 'de'] }),
      'messages/en.json': JSON.stringify({ title: 'Inbox', items: plural('{count} item', '{count} items') }),
      'messages/de.json': JSON.stringify({ title: 'Eingang', items: plural('{count} Eintrag', '{count} Einträge') }),
      'src/sinter.content.ts': "import { languages } from '@tiaforge-ui/sinter/content';\nimport { inlang, inlangLocales } from '@tiaforge-ui/sinter/messages/content';\nexport const locales = languages(({ root }) => inlangLocales('project.inlang', root));\nexport const messages = inlang();\n",
      'src/plain.ts': "import { m } from '@tiaforge-ui/sinter/messages';\nexport const shout = (x: unknown) => m.title().toUpperCase() + String(x);\n",
      'src/count.ts': "import { m } from '@tiaforge-ui/sinter/messages';\nexport const many = (n: number) => m.items({ count: n });\n",
      'src/sinter.helpers.ts': "export { shout } from './plain.ts';\nexport { many } from './count.ts';\n",
      'none.html': page('<p data-sn-text="d.n"></p>'),
      'plain.html': page('<p data-sn-text="shout(d.n)"></p>'),
      'count.html': page('<p data-sn-text="many(d.n)"></p>'),
    };
    for (const [k, v] of Object.entries(f)) { mkdirSync(dirname(join(app, k)), { recursive: true }); writeFileSync(join(app, k), v); }
    const dist = join(app, 'dist');
    await build({ root: app, logLevel: 'silent', resolve: { alias }, plugins: [sinter({ localePrefix: true, typecheck: false })], build: { outDir: dist, emptyOutDir: true, rollupOptions: { input: ['none.html', 'plain.html', 'count.html'].map((x) => join(app, x)) } } });
    // a page's scripts: its own, and every chunk they import
    const shipped = (rel: string) => {
      const html = readFileSync(join(dist, rel), 'utf8'), seen = new Set<string>(), todo = [...html.matchAll(/(?:src|href)="\/(assets\/[^"]+\.js)"/g)].map((x) => x[1]!);
      let js = '';
      while (todo.length) {
        const a = todo.pop()!;
        if (seen.has(a)) continue;
        seen.add(a);
        const c = readFileSync(join(dist, a), 'utf8');
        js += c;
        for (const x of c.matchAll(/from\s*["'`]\.\/([^"'`]+\.js)["'`]/g)) todo.push(`assets/${x[1]}`);
      }
      return { html, js };
    };
    const none = shipped('de/none/index.html'), plain = shipped('de/plain/index.html'), count = shipped('de/count/index.html');
    expect(none.html).not.toContain('data-sn-ns');
    expect(none.js).not.toContain('sinter.i18n');
    expect(plain.html).toContain('<script type="application/json" data-sn-ns="m" lang="de">{"title":"Eingang"}</script>');
    expect(plain.js).toContain('sinter.i18n');
    expect(plain.js).not.toContain('PluralRules');
    expect(count.html).toMatch(/data-sn-ns="m" lang="de">\{"items":\{"s":/);
    expect(count.js).toContain('PluralRules');
    // the page's language is the formatters' locale, without messages too
    expect(none.js).toMatch(/\(`de`\)/);
  } finally {
    rmSync(app, { recursive: true, force: true });
  }
}, 120_000);
