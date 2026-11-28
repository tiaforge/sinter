// @vitest-environment node
// SN350 (docs/diagnostics.md#sn350-messages-by-name): app code calls the built-in messages as `m.key()`; every other way
// to them is a build error that says what to write, since the build could not tell which entries a page needs (its
// dictionary, its early script's texts) and the message would show its key. Each way, built as an app module a page uses.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { build } from 'vite';
import { afterAll, expect, test } from 'vitest';
import sinter from '../../src/vite.js';

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
const built = async (label: string, extra: Record<string, string> = {}) => {
  const root = join(tmp, `s${n++}`);
  for (const [f, text] of Object.entries({ ...FILES, 'src/lib/label.ts': label, ...extra })) { mkdirSync(dirname(join(root, f)), { recursive: true }); writeFileSync(join(root, f), text); }
  await build({ root, logLevel: 'silent', resolve: { alias }, plugins: [sinter({ localePrefix: true, typecheck: false })], build: { outDir: join(root, 'dist'), emptyOutDir: true, rollupOptions: { input: [join(root, 'index.html')] } } });
};
const IMPORT = "import { m } from '@tiaforge-ui/sinter/messages';\n";

test('`m.key()`, `getLocale`, `install` and the types build', async () => {
  await built(`import { m, getLocale, install, type Messages } from '@tiaforge-ui/sinter/messages';\nimport type { Entries } from '@tiaforge-ui/sinter/messages';\nvoid install; export const label = (): string => m.hello() + getLocale();\nexport type T = Messages | Entries;\n`);
}, 60_000);

test('TypeScript: a message in a `namespace` body or an `enum` is read (its entry is in the page)', async () => {
  await built(`${IMPORT}export namespace N { export const x = (): string => m.bye(); }\nexport enum E { A = m.hello().length }\nexport const label = (): string => N.x() + E.A;\n`);
}, 60_000);

const CASES: Array<[string, string, Record<string, string>, RegExp]> = [
  ['`m[key]`', `${IMPORT}export const label = (k = 'hello'): string => (m as any)[k]();\n`, {}, /SN350 .*label\.ts:2:\d+: `m` is used other than as `m\.key`/],
  ['a computed key', `${IMPORT}export const label = (k = 'hello'): string => m[k as 'hello']();\n`, {}, /SN350 .*`m\[…\]`: messages are named literally/],
  ['`export { m }`', `${IMPORT}export { m };\nexport const label = (): string => m.hello();\n`, {}, /SN350 .*label\.ts:2:\d+: `export \{ m \}` passes the messages on/],
  ['a re-export', `export { m } from '@tiaforge-ui/sinter/messages';\nimport { m as x } from '@tiaforge-ui/sinter/messages';\nexport const label = (): string => x.hello();\n`, {}, /SN350 .*label\.ts:1:1: a re-export of '@tiaforge-ui\/sinter\/messages' passes the messages on/],
  ['`export *`', `export * from '@tiaforge-ui/sinter/messages';\nexport const label = (): string => '';\n`, {}, /SN350 .*a re-export of/],
  ['a namespace import', `import * as msg from '@tiaforge-ui/sinter/messages';\nexport const label = (): string => msg.m.hello();\n`, {}, /SN350 .*label\.ts:1:8: `import \* as …` of '@tiaforge-ui\/sinter\/messages': import `\{ m \}`/],
  ['`t(key)`', `import { t } from '@tiaforge-ui/sinter/messages';\nexport const label = (): string => t('hello');\n`, {}, /SN350 .*`t` from '@tiaforge-ui\/sinter\/messages' reads the messages by a key the build does not see/],
  ['`import()`', `export const label = async (): Promise<string> => (await import('@tiaforge-ui/sinter/messages')).m.hello();\n`, {}, /SN350 .*`import\(\)` or `require\(\)` of/],
  ['TypeScript\'s `import = require()`', `import msg = require('@tiaforge-ui/sinter/messages');\nexport const label = (): string => msg.m.hello();\n`, {}, /SN350 .*label\.ts:1:\d+: `import\(\)` or `require\(\)` of/],
  ['an alias',`import { m } from '~messages';\nexport const label = (): string => m.hello();\n`, {}, /SN350 .*label\.ts:1:\d+: `~messages` is `@tiaforge-ui\/sinter\/messages` under another name/],
  ['the file\'s path', `import { m } from ${JSON.stringify(`${src}/messages.ts`)};\nexport const label = (): string => m.hello();\n`, {}, /SN350 .*is `@tiaforge-ui\/sinter\/messages` under another name/],
  ['a decorator', `${IMPORT}const d = (_s: string) => (t: unknown) => t;\n@d(m.bye())\nclass C {}\nexport const label = (): string => m.hello() + String(C);\n`, {}, /SN350 .*`m\.bye` stands where the build does not read it/],
];
for (const [what, label, extra, error] of CASES) {
  test(`${what}: SN350, saying what to write`, async () => {
    await expect(built(label, extra)).rejects.toThrow(error);
  }, 60_000);
}
