// Built-in messages: `m.key()` in markup and app code, `{param}`s, the base language for missing translations, a
// page in one language (`$locale` cannot be written); and the build side (inlang files, types, keys per module).
import { expect, test } from 'vitest';
import { firstPaint, render } from '@tiaforge-ui/sinter/testing';
import { m } from '../../src/messages.js';
import { keysOnly, moduleKeys } from '../../src/i18n-build.js';

const messages = {
  en: { title: 'People', hello: 'Hello {name}', only_en: 'Only in English' },
  de: { title: 'Leute', hello: 'Hallo {name}' },
};
const page = `<body data-sn-state="{ who: 'Ada' }">
  <h1 data-sn-text="m.title()"></h1>
  <p data-sn-text="m.hello({ name: who })"></p>
  <p data-sn-text="m.only_en()"></p>
  <p data-sn-text="$locale"></p>
</body>`;
const texts = () => [...document.querySelectorAll('h1, p')].map((e) => e.textContent);

test('m.key() with {param}s, in the page\'s language; a missing translation is the base language', async () => {
  await render(page, { messages, locale: 'de' });
  expect(texts()).toEqual(['Leute', 'Hallo Ada', 'Only in English', 'de']);
  await render(page, { messages });
  expect(texts()).toEqual(['People', 'Hello Ada', 'Only in English', 'en']);
});

test('a page has one language: writing `$locale` is SN203', async () => {
  await expect(render('<button data-sn-on-click="$locale = \'en\'">en</button>', { messages, locale: 'de' }))
    .rejects.toThrow(/SN203.*`\$locale` is this page's language \(`de`/s);
});

test('app code reads the same dictionary through `m` from the messages module', async () => {
  await render(page, { messages, locale: 'de' });
  expect((m as unknown as { hello(p: { name: string }): string }).hello({ name: 'Bo' })).toBe('Hallo Bo');
});

test('first paint: the early step renders messages in the page\'s language', async () => {
  await firstPaint(page, { messages, locale: 'de' });
  expect(texts()).toEqual(['Leute', 'Hallo Ada', 'Only in English', 'de']);
});

test('unknown messages are build errors with a suggestion', async () => {
  await expect(render('<p data-sn-text="m.titel()"></p>', { messages })).rejects.toThrow(/SN206.*`m\.titel` is not exported.*title/s);
});

test('modules: `m.key` is collected; `m[key]` and passing `m` on are refused', () => {
  const src = `import { m } from '@tiaforge-ui/sinter/messages';\nexport const a = () => m.title() + m.hello({ name: 'x' });\n`;
  expect(moduleKeys(src, '/a.ts')).toEqual({ keys: ['hello', 'title'], errors: [] });
  expect(moduleKeys(`import { m as t } from '@tiaforge-ui/sinter/messages';\nexport const b = (k: string) => (t as any)[k]();\n`, '/b.ts').errors[0]).toMatch(/\/b\.ts:2:\d+: `t` is used other than as `t\.key`/);
  expect(moduleKeys(`import { m } from '@tiaforge-ui/sinter/messages';\nexport const c = (k) => m[k]();\n`, '/c.js').errors[0]).toMatch(/\/c\.js:2:\d+: `m\[…\]`/);
  expect(moduleKeys(`export const m = { x: 1 };\nm.x;\n`, '/d.js')).toEqual({ keys: [], errors: [] });
});


test('the messages as a namespace: install() reads the page\'s entries, `m.inbox.unread()` formats one', async () => {
  const { install, state } = await import('../../src/messages.js');
  const { format } = await import('../../src/messages/format.js');
  const { parseComplex } = await import('../../src/messages/content.js');
  const unread = parseComplex([{ declarations: ['local n = count: plural'], selectors: ['n'], match: { 'n=one': '{count} Nachricht', 'n=*': '{count} Nachrichten' } }], 'x');
  (globalThis as any)[Symbol.for('sinter.i18n')] = undefined;
  document.body.innerHTML = `<script type="application/json" data-sn-ns="m">${JSON.stringify({ 'inbox.unread': { id: 'inbox.unread', m: unread } })}</script>`;
  install('de', format as never);
  const mm = m as unknown as { inbox: { unread(p: { count: number }): string } };
  expect([mm.inbox.unread({ count: 1 }), mm.inbox.unread({ count: 3 })]).toEqual(['1 Nachricht', '3 Nachrichten']);
  expect(state().locale).toBe('de');
});

test('the messages module starts on its first call: the page\'s entries and their language, with no install()', async () => {
  const { state } = await import('../../src/messages.js');
  (globalThis as any)[Symbol.for('sinter.i18n')] = undefined;
  document.body.innerHTML = '<script type="application/json" data-sn-ns="m" lang="de">{"bye":"Tschüss {name}"}</script>';
  expect((m as unknown as { bye(p: { name: string }): string }).bye({ name: 'Ada' })).toBe('Tschüss Ada');
  expect(state().locale).toBe('de');
  (globalThis as any)[Symbol.for('sinter.i18n')] = undefined;
});

// A build writes most of a page's dictionary into a file the page module imports first (docs/messages.md): the file's
// text is `FILE(entries)`, as src/vite.ts writes it. It may run before the page's language is read (no head script
// called a message) or after.
const FILE = (d: Record<string, unknown>) => `{const s=globalThis[Symbol.for("sinter.i18n")]??={locale:"",base:"",locales:[],dicts:{}};let l=s.locale;if(!l)try{l=document.querySelector('script[data-sn-ns="m"]')?.getAttribute("lang")??document.documentElement.lang}catch{}Object.assign(s.dicts[l||" "]??={},${JSON.stringify(d)})}`;
// eslint-disable-next-line no-new-func -- the file's text, run as the browser runs the module
const run = (d: Record<string, unknown>) => new Function(FILE(d))();
type M = Record<string, (p?: Record<string, unknown>) => string>;

test('a dictionary file that runs before any message was called: its entries wait under the page\'s language, and the first call has them with the page\'s own', async () => {
  const { state } = await import('../../src/messages.js');
  (globalThis as any)[Symbol.for('sinter.i18n')] = undefined;
  document.documentElement.lang = 'de';
  document.body.innerHTML = '<script type="application/json" data-sn-ns="m" lang="de">{"early":"Früh"}</script>';
  try {
    run({ late: 'Spät {n}', early: 'Früh' });
    // (the module has not started: the language is not set, only looked up for where the entries go)
    expect(state().locale).toBe('');
    expect(Object.keys(state().dicts)).toEqual(['de']);
    expect([(m as unknown as M).late!({ n: 2 }), (m as unknown as M).early!()]).toEqual(['Spät 2', 'Früh']);
    expect(state().locale).toBe('de');
    // a second page's file (a swap): added to what is there
    run({ other: 'Anders' });
    expect([(m as unknown as M).other!(), (m as unknown as M).late!({ n: 1 })]).toEqual(['Anders', 'Spät 1']);
  } finally { (globalThis as any)[Symbol.for('sinter.i18n')] = undefined; document.documentElement.removeAttribute('lang'); }
});

test('a dictionary file that runs after a head script called a message: added to the page\'s language', async () => {
  const { state } = await import('../../src/messages.js');
  (globalThis as any)[Symbol.for('sinter.i18n')] = undefined;
  document.body.innerHTML = '<script type="application/json" data-sn-ns="m" lang="de">{"early":"Früh"}</script>';
  try {
    expect((m as unknown as M).early!()).toBe('Früh');
    // (not there yet: the key, as for any message the page does not hold)
    expect((m as unknown as M).late!()).toBe('late');
    run({ late: 'Spät', early: 'Früh' });
    expect((m as unknown as M).late!()).toBe('Spät');
    expect(state().dicts.de).toEqual({ early: 'Früh', late: 'Spät' });
  } finally { (globalThis as any)[Symbol.for('sinter.i18n')] = undefined; }
});

test('a page whose head keeps no entry has no dictionary element: the language is the document\'s, the entries the file\'s', async () => {
  const { state } = await import('../../src/messages.js');
  (globalThis as any)[Symbol.for('sinter.i18n')] = undefined;
  document.documentElement.lang = 'de';
  document.body.innerHTML = '';
  try {
    run({ late: 'Spät' });
    expect((m as unknown as M).late!()).toBe('Spät');
    expect(state().locale).toBe('de');
  } finally { (globalThis as any)[Symbol.for('sinter.i18n')] = undefined; document.documentElement.removeAttribute('lang'); }
  // a document that names no language: as the module has it
  document.body.innerHTML = '';
  try {
    run({ late: 'Late' });
    expect((m as unknown as M).late!()).toBe('Late');
    expect(state().locale).toBe(' ');
  } finally { (globalThis as any)[Symbol.for('sinter.i18n')] = undefined; }
});

test('keysOnly: a module reads the messages through the keys `moduleKeys` found, or the answer is no', () => {
  const M = "import { m } from '@tiaforge-ui/sinter/messages';\n";
  const yes = (src: string, id = '/a.ts') => expect(keysOnly(src, id), src).toBe(true);
  const no = (src: string, id = '/a.ts') => expect(keysOnly(src, id), src).toBe(false);
  // through its keys: calls, a nested id, an alias of the import, a name that is no reference
  yes(M + 'export const a = () => m.title() + m.inbox.unread({ n: 1 });\nexport const b = { m: 1, x: { m: 2 } }.x.m;\n');
  yes("import { m as msg } from '@tiaforge-ui/sinter/messages';\nexport const a = () => msg.title();\n");
  yes('export const a = 1;\n');
  // a type is no use of it: a member named `m`, an annotation, a cast's type, a type argument
  yes(M + 'interface Time { h: number; m?: number }\ntype T = { m: string };\nexport const a = (t: Time, u: { m: number }): { m: number } => ({ h: t.h, m: t.m ?? u.m, x: m.title() } as { m: number; h: number });\nexport const b = new Map<string, { m: number }>();\n');
  yes(M + 'declare const m2: { m: number };\nexport const a = () => m.title();\n');
  yes("import { x } from './other';\nexport const a = () => x.m;\n");
  // what `moduleKeys` refuses as well
  no(M + 'export const a = (k: string) => (m as any)[k]();\n');
  no(M + 'export const a = () => helper(m);\n');
  no(M + 'const { title } = m;\nexport const a = () => title();\n');
  // what it does not see: the name handed on, or used where its walker does not go
  no(M + 'export { m };\n');
  no(M + 'export { m as messages };\n');
  no(M + 'export default m;\n');
  no(M + 'namespace N { export const all = () => Object.keys(m); }\nexport const a = N.all;\n');
  no(M + 'namespace N { export const t = () => m.hidden(); }\nexport const a = N.t;\n');
  no(M + 'enum E { A = m.hidden().length }\nexport const a = E.A;\n');
  no(M + 'export class C { constructor(private readonly all = m) {} }\n');
  no(M + 'export const a = { m };\n');
  no(M + 'export const a = typeof m;\n');
  no(M + 'export const a = (m as unknown as Record<string, () => string>).title();\n');
  no(M + 'export const a = <T,>(x: T) => x;\nexport const b = a<object>(m);\n');
  // other ways to the module
  no("import { m, t } from '@tiaforge-ui/sinter/messages';\nexport const a = () => m.title() + t('x');\n");
  no("import { t } from '@tiaforge-ui/sinter/messages';\nexport const a = () => t('title');\n");
  no("import * as all from '@tiaforge-ui/sinter/messages';\nexport const a = () => all.m.title();\n");
  no("export { m } from '@tiaforge-ui/sinter/messages';\n");
  no("export * from '@tiaforge-ui/sinter/messages';\n");
  no("export const a = async () => (await import('@tiaforge-ui/sinter/messages')).m.title();\n");
  no("export const a = async () => (await import(`@tiaforge-ui/sinter/messages`)).t('x');\n");
  no("const { m } = require('@tiaforge-ui/sinter/messages');\nexport const a = () => m.title();\n", '/a.cjs');
  // a module that cannot be parsed
  no(M + 'export const a = (;\n');
});
