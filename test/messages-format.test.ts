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
  expect(() => parsePattern('{rate: number style=percent}', 'en.json: `rate`')).toThrow(/en\.json: `rate`: `\{rate: number style=percent\}` is not a placeholder sinter reads yet/);
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
