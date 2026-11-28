// @vitest-environment node
// SN350 (docs/diagnostics.md#sn350-messages-by-name): app code calls the built-in messages as `m.key()`; the ways to them
// that the module's import and export statements decide (a namespace or default import, an export that reads entries by
// key, `m` passed on by an export, `import()`, another spelling of the module), and main's `m[key]` and `m` passed on,
// are build errors that say what to write, since the build could not tell which entries a page needs and the message
// would show its key. Each way, built as an app module a page uses; and what builds, with the page's entry.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { build } from 'vite';
import { afterAll, expect, test } from 'vitest';
import sinter from '../../src/vite.js';
import { READS_BY_KEY, statementReach } from '../../src/i18n-build.js';

const src = resolve(__dirname, '../../src');
const alias = [{ find: /^~messages$/, replacement: `${src}/messages.ts` }, { find: /^@tiaforge-ui\/sinter\/runtime$/, replacement: `${src}/runtime-entry.ts` }, { find: /^@tiaforge-ui\/sinter\/(?:runtime\/)?(.+)$/, replacement: `${src}/$1.ts` }, { find: /^@tiaforge-ui\/sinter$/, replacement: `${src}/index.ts` }];
const tmp = mkdtempSync(join(tmpdir(), 'sinter-messages-reach-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const FILES: Record<string, string> = {
  'project.inlang/settings.json': JSON.stringify({ baseLocale: 'en', locales: ['en', 'de'] }),
  'src/sinter.content.ts': `import { languages } from '@tiaforge-ui/sinter/content';\nimport { inlang, inlangLocales } from '@tiaforge-ui/sinter/messages/content';\nexport const locales = languages(({ root }) => inlangLocales('project.inlang', root));\nexport const messages = inlang();\n`,
  'messages/en.json': JSON.stringify({ hello: 'Hello', bye: 'Bye' }),
  'messages/de.json': JSON.stringify({ hello: 'Hallo', bye: 'Tschüss' }),
  'src/sinter.helpers.ts': `export { label } from './lib/label.ts';\n`,
  'index.html': `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>t</title></head><body data-sn-state="{ s: '' }"><button data-sn-on-click="s = label()">go</button><p data-sn-text="s"></p></body></html>\n`,
};
let n = 0;
/** builds the site with `label` as its module; the German page's dictionary (the entries are few: it stays in the page) */
const built = async (label: string, extra: Record<string, string> = {}) => {
  const root = join(tmp, `s${n++}`);
  for (const [f, text] of Object.entries({ ...FILES, 'src/lib/label.ts': label, ...extra })) { mkdirSync(dirname(join(root, f)), { recursive: true }); writeFileSync(join(root, f), text); }
  await build({ root, logLevel: 'silent', resolve: { alias }, plugins: [sinter({ localePrefix: true, typecheck: false })], build: { outDir: join(root, 'dist'), emptyOutDir: true, rollupOptions: { input: [join(root, 'index.html')] } } });
  const html = readFileSync(join(root, 'dist/de/index.html'), 'utf8');
  return JSON.parse(/<script type="application\/json" data-sn-ns="m"[^>]*>(.*?)<\/script>/s.exec(html)?.[1] ?? '{}') as Record<string, string>;
};
const IMPORT = "import { m } from '@tiaforge-ui/sinter/messages';\n";

test('`m.key()`, `getLocale`, `install` and the types build', async () => {
  expect(await built(`import { m, getLocale, install, type Messages } from '@tiaforge-ui/sinter/messages';\nimport type { Entries } from '@tiaforge-ui/sinter/messages';\nvoid install; export const label = (): string => m.hello() + getLocale();\nexport type T = Messages | Entries;\n`)).toEqual({ hello: 'Hallo' });
}, 60_000);

test('TypeScript: a message in a `namespace` body or an `enum` is read (its entry is in the page)', async () => {
  expect(await built(`${IMPORT}export namespace N { export const x = (): string => m.bye(); }\nexport enum E { A = m.hello().length }\nexport const label = (): string => N.x() + E.A;\n`)).toEqual({ bye: 'Tschüss', hello: 'Hallo' });
}, 60_000);

// what SN350 decides from statements alone: a name that is not `m`, a binding, a label or a member is no use of the messages
const BUILDS: Array<[string, string]> = [
  ['a type imported beside `m` without the `type` keyword', `import { m, Messages } from '@tiaforge-ui/sinter/messages';\nexport const all: Messages | null = null;\nexport const label = (): string => m.hello();\n`],
  ['a type re-exported with an inline `type`', `${IMPORT}export { type Messages } from '@tiaforge-ui/sinter/messages';\nexport const label = (): string => m.hello();\n`],
  ['an enum with a member named `m`', `${IMPORT}export enum Unit { s, m, h }\nexport const label = (): string => m.hello() + Unit.m;\n`],
  ['a label named `m`', `${IMPORT}export const label = (): string => { m: for (;;) { break m; } return m.hello(); };\n`],
  ['an unused binding named `m` (`catch (m)`, a callback\'s parameter)', `${IMPORT}export const label = (): string => { try { return [1].map((x, m) => x).join() + m.hello(); } catch (m) { return ''; } };\n`],
  ['`export { x as m }` of another value', `${IMPORT}const metres = 1;\nexport { metres as m };\nexport const label = (): string => m.hello();\n`],
  ['`getLocale` re-exported', `${IMPORT}export { getLocale } from '@tiaforge-ui/sinter/messages';\nexport const label = (): string => m.hello();\n`],
];
for (const [what, label] of BUILDS) {
  test(`${what}: builds, and the page has the entry`, async () => {
    expect(await built(label)).toEqual({ hello: 'Hallo' });
  }, 60_000);
}

const CASES: Array<[string, string, Record<string, string>, RegExp]> = [
  // (the two of main's reading, `moduleKeys`, which had no code)
  ['`m[key]`', `${IMPORT}export const label = (k = 'hello'): string => (m as any)[k]();\n`, {}, /SN350 .*label\.ts:2:\d+: `m` is used other than as `m\.key`/],
  ['a computed key', `${IMPORT}export const label = (k = 'hello'): string => m[k as 'hello']();\n`, {}, /SN350 .*`m\[…\]`: messages are named literally/],
  ['`export { m }`', `${IMPORT}export { m };\nexport const label = (): string => m.hello();\n`, {}, /SN350 .*label\.ts:2:10: `m` exported passes the messages on/],
  ['`export { m as all }`', `${IMPORT}export { m as all };\nexport const label = (): string => m.hello();\n`, {}, /SN350 .*label\.ts:2:10: `m` exported passes the messages on/],
  ['a re-export of `m`', `export { m } from '@tiaforge-ui/sinter/messages';\nimport { m as x } from '@tiaforge-ui/sinter/messages';\nexport const label = (): string => x.hello();\n`, {}, /SN350 .*label\.ts:1:10: a re-export of '@tiaforge-ui\/sinter\/messages' passes `m` on/],
  ['a re-export of `t`', `${IMPORT}export { t as tr } from '@tiaforge-ui/sinter/messages';\nexport const label = (): string => m.hello();\n`, {}, /SN350 .*a re-export of '@tiaforge-ui\/sinter\/messages' passes `t` on/],
  ['`export *`', `export * from '@tiaforge-ui/sinter/messages';\nexport const label = (): string => '';\n`, {}, /SN350 .*label\.ts:1:1: a re-export of '@tiaforge-ui\/sinter\/messages' passes the messages on/],
  ['`export * as`', `export * as msg from '@tiaforge-ui/sinter/messages';\nexport const label = (): string => '';\n`, {}, /SN350 .*a re-export of '@tiaforge-ui\/sinter\/messages' passes the messages on/],
  ['a namespace import', `import * as msg from '@tiaforge-ui/sinter/messages';\nexport const label = (): string => msg.m.hello();\n`, {}, /SN350 .*label\.ts:1:8: `import \* as msg` of '@tiaforge-ui\/sinter\/messages': import `\{ m \}`/],
  ['a default import', `import msgs from '@tiaforge-ui/sinter/messages';\nexport const label = (): string => String(msgs);\n`, {}, /SN350 .*label\.ts:1:8: a default import of '@tiaforge-ui\/sinter\/messages', which has none/],
  ['`t(key)`', `import { t } from '@tiaforge-ui/sinter/messages';\nexport const label = (): string => t('hello');\n`, {}, /SN350 .*`t` from '@tiaforge-ui\/sinter\/messages' reads the messages by a key the build does not see/],
  ['`state()`', `${IMPORT}import { state } from '@tiaforge-ui/sinter/messages';\nexport const label = (): string => m.hello() + Object.keys(state().dicts);\n`, {}, /SN350 .*`state` from '@tiaforge-ui\/sinter\/messages' reads the messages by a key/],
  ['`import()`', `export const label = async (): Promise<string> => (await import('@tiaforge-ui/sinter/messages')).m.hello();\n`, {}, /SN350 .*`import\(\)` or `require\(\)` of/],
  ['TypeScript\'s `import = require()`', `import msg = require('@tiaforge-ui/sinter/messages');\nexport const label = (): string => msg.m.hello();\n`, {}, /SN350 .*label\.ts:1:\d+: `import\(\)` or `require\(\)` of/],
  ['an alias', `import { m } from '~messages';\nexport const label = (): string => m.hello();\n`, {}, /SN350 .*label\.ts:1:\d+: `~messages` is `@tiaforge-ui\/sinter\/messages` under another name/],
  ['the file\'s path', `import { m } from ${JSON.stringify(`${src}/messages.ts`)};\nexport const label = (): string => m.hello();\n`, {}, /SN350 .*is `@tiaforge-ui\/sinter\/messages` under another name/],
];
for (const [what, label, extra, error] of CASES) {
  test(`${what}: SN350, saying what to write`, async () => {
    await expect(built(label, extra)).rejects.toThrow(error);
  }, 60_000);
}

test('the exports that read entries by key, by name: `t` and `state`; any other name is allowed', () => {
  expect(READS_BY_KEY).toEqual(['t', 'state']);
  const at = (names: string) => statementReach(`import { m, ${names} } from '@tiaforge-ui/sinter/messages';\n`, 'a.ts');
  expect(at('t')).toMatchObject({ how: 'import', name: 't' });
  expect(at('state')).toMatchObject({ how: 'import', name: 'state' });
  for (const name of ['getLocale', 'install', 'Messages', 'Entries', 'I18nState', 'anythingElse']) expect(at(name)).toBeNull();
  expect(at('type t')).toBeNull();
});
