// @vitest-environment node
// The messages' formatter and the inlang loader's parser (docs/proposals/messages.md §2): nested ids, placeholders and
// escapes, complex messages (plural, ordinal, an exact number, a choice on an input, `*`, several selectors).
import { expect, test } from 'vitest';
import { format } from '../src/messages/format.js';
import { flatten, parsePattern, parseComplex } from '../src/messages/content.js';

const plural = (one: string, other: string, extra: Record<string, string> = {}) => parseComplex([{
  declarations: ['input count', 'local n = count: plural'], selectors: ['n'],
  match: { 'n=one': one, ...Object.fromEntries(Object.entries(extra).map(([k, v]) => [`n=${k}`, v])), 'n=*': other },
}], 'x');

test('placeholders and escapes', () => {
  expect(parsePattern('Hi {name}, \\{literal\\} \\\\', 'x')).toEqual(['Hi ', { v: 'name' }, ', {literal} \\']);
  expect(format({ m: { p: parsePattern('Hi {name}', 'x') } }, { name: 'Ada' })).toBe('Hi Ada');
  expect(format({ m: { p: parsePattern('Hi {name}', 'x') } }, {})).toBe('Hi {name}');
  expect(() => parsePattern('{#b}bold{/b}', 'en.json: `b`')).toThrow(/en\.json: `b`: `\{#b\}` is not a placeholder sinter reads/);
  // formatted placeholders: Intl in the page's language
  const rate = { m: { p: parsePattern('{rate: number style=percent} done', 'x') } };
  expect(format(rate, { rate: 0.25 }, 'en')).toBe('25% done');
  expect(format(rate, { rate: 0.25 }, 'de')).toMatch(/^25\s%\sdone$/u);
  const at = { m: { p: parsePattern('on {at: datetime dateStyle=long timeZone=UTC}', 'x') } };
  expect(format(at, { at: '2026-11-21T10:00:00Z' }, 'de')).toBe('on 21. November 2026');
});

test('plurals in each language\'s categories', () => {
  const en = plural('{count} message', '{count} messages');
  expect([1, 2, 0].map((count) => format({ m: en }, { count }, 'en'))).toEqual(['1 message', '2 messages', '0 messages']);
  const pl = plural('{count} wiadomość', '{count} wiadomości', { few: '{count} wiadomości (few)', many: '{count} wiadomości (many)' });
  expect([1, 2, 5, 22].map((count) => format({ m: pl }, { count }, 'pl'))).toEqual(['1 wiadomość', '2 wiadomości (few)', '5 wiadomości (many)', '22 wiadomości (few)']);
  const ar = parseComplex([{ declarations: ['local n = count: plural'], selectors: ['n'], match: Object.fromEntries(['zero', 'one', 'two', 'few', 'many', 'other'].map((c) => [`n=${c}`, c])) }], 'x');
  expect([0, 1, 2, 3, 11, 100].map((count) => format({ m: ar }, { count }, 'ar'))).toEqual(['zero', 'one', 'two', 'few', 'many', 'other']);
});

test('an exact number wins over the category that also selects it (French `one` selects 0)', () => {
  const fr = parseComplex([{ declarations: ['local n = count: plural'], selectors: ['n'], match: { 'n=0': 'aucun', 'n=one': 'un', 'n=*': '{count}' } }], 'x');
  expect([0, 1, 5].map((count) => format({ m: fr }, { count }, 'fr'))).toEqual(['aucun', 'un', '5']);
});

test('ordinals, a choice on an input, several selectors', () => {
  const place = parseComplex([{ declarations: ['input n', 'local ord = n: plural type=ordinal'], selectors: ['ord'], match: { 'ord=one': '{n}st', 'ord=two': '{n}nd', 'ord=few': '{n}rd', 'ord=*': '{n}th' } }], 'x');
  expect([1, 2, 3, 4, 11, 21].map((n) => format({ m: place }, { n }, 'en'))).toEqual(['1st', '2nd', '3rd', '4th', '11th', '21st']);
  const two = parseComplex([{ declarations: ['input platform', 'input userGender'], selectors: ['platform', 'userGender'], match: { 'platform=android, userGender=male': 'his Android', 'platform=android, userGender=*': 'their Android', 'platform=*, userGender=*': 'their device' } }], 'x');
  expect([format({ m: two }, { platform: 'android', userGender: 'male' }), format({ m: two }, { platform: 'android', userGender: 'x' }), format({ m: two }, { platform: 'ios' })]).toEqual(['his Android', 'their Android', 'their device']);
});

test('nested objects are dotted ids; a message and a group at one id fail', () => {
  const m = flatten({ $schema: 'x', inbox: { title: 'Inbox', unread: 'n' }, plain: 'P' }, 'en.json');
  expect([...m.keys()]).toEqual(['inbox.title', 'inbox.unread', 'plain']);
  expect(() => parseComplex([{ selectors: ['x'] }], 'en.json: `a`')).toThrow(/a complex message is/);
  expect(() => parseComplex([{ declarations: ['local y = x: datetime'], selectors: ['y'], match: {} }], 'en.json: `a`')).toThrow(/`datetime` in `local y = x: datetime` is not a function sinter reads/);
});

test('the messages\' type: nested, a plural\'s input a number, a placeholder string or number', async () => {
  const { messagesType } = await import('../src/messages/content.js');
  const m = flatten({ inbox: { title: 'Inbox', unread: [{ declarations: ['local n = count: plural'], selectors: ['n'], match: { 'n=*': '{count} new, {who}' } }] } }, 'en.json');
  expect(messagesType([...m].map(([id, x]) => ({ id, m: x })))).toBe('{ "inbox": { "title": () => string; "unread": (args: { "count": number; "who": string | number }) => string } }');
});

test('sinter check: a wrong parameter of a namespace\'s message is a type error', async () => {
  const { compile } = await import('../src/compiler/index.js');
  const { check, findTsc } = await import('../src/check/index.js');
  const { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } = await import('node:fs');
  const { join, resolve } = await import('node:path');
  const { tmpdir } = await import('node:os');
  const root = mkdtempSync(join(tmpdir(), 'sinter-nstype-'));
  // the repository's TypeScript, as an app has its own
  mkdirSync(join(root, 'node_modules'));
  symlinkSync(resolve(__dirname, '../node_modules/typescript'), join(root, 'node_modules/typescript'), 'dir');
  try {
    const helpers = { module: null, names: [] as string[], namespaces: { m: { module: 'sinter:content/m', members: ['inbox.unread'], type: '{ "inbox": { "unread": (args: { "count": number }) => string } }' } } };
    const run = (expr: string) => {
      const html = `<p data-sn-text="${expr}"></p>`;
      writeFileSync(join(root, 'index.html'), html);
      const out = compile(html, { file: join(root, 'index.html'), root, dev: false, readFile: () => '', helpers, check: true, contentNs: { m: { entries: { 'inbox.unread': { m: { p: ['x'] } } }, format: '/f.ts' } } });
      return check({ root, units: [out.check!], helpers, types: null, tsc: findTsc(root)! }).diagnostics.map((d) => d.message);
    };
    expect(run('m.inbox.unread({ count: 2 })').join(' | ')).toBe('');
    expect(run("m.inbox.unread({ cnt: 2 })").join()).toMatch(/cnt/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 60_000);

test('pack(): a plain message is its text for a page\'s modules; a brace of its own, a formatted placeholder or a plural stays the message', async () => {
  const { pack } = await import('../src/messages/format.js');
  const { t, install } = await import('../src/messages.js');
  expect(pack({ id: 'a', m: { p: ['Hello ', { v: 'name' }] } })).toBe('Hello {name}');
  expect(pack({ id: 'a', m: { p: ['Set {x}'] } })).toEqual({ p: ['Set {x}'] });
  expect(pack({ id: 'a', m: { p: [{ v: 'rate', f: 'number' }] } })).toEqual({ p: [{ v: 'rate', f: 'number' }] });
  const plural = { s: [{ n: 'count', f: 'plural' }], v: [[['one'], ['1 item']], [['*'], [{ v: 'count' }, ' items']]] };
  expect(pack({ id: 'n', m: plural })).toEqual(plural);
  // the runtime reads both forms
  const { format } = await import('../src/messages/format.js');
  install('en', format as never);
  Object.assign((globalThis as any)[Symbol.for('sinter.i18n')].dicts.en, { a: pack({ id: 'a', m: { p: ['Hello ', { v: 'name' }] } }), n: pack({ id: 'n', m: plural }) });
  expect(t('a', { name: 'Ada' })).toBe('Hello Ada');
  expect(t('n', { count: 3 })).toBe('3 items');
  (globalThis as any)[Symbol.for('sinter.i18n')] = undefined;
});
