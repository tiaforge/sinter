// Small pure functions of the runtime.
import { expect, test } from 'vitest';
import { withParams } from '../src/runtime/app.js';
import { serialize } from '../src/form.js';
import { bytes, date, number, relative } from '../src/runtime/helpers.js';
import { configure } from '../src/runtime/config.js';

test('withParams: only the first `?` starts the query; the hash stays last', () => {
  expect(withParams('/a?x=1?y', { p: '2' })).toBe('/a?x=1%3Fy&p=2');
  expect(withParams('/a#h', { p: '2' })).toBe('/a?p=2#h');
  expect(withParams('/a?p=1', { p: '2' })).toBe('/a?p=2');
});

test('serialize: a scalar and a nested field under one name do not throw; the later control wins', () => {
  const f = document.createElement('form');
  f.innerHTML = '<input name="a" value="1"><input name="a.b" value="2"><input name="c.d" value="3"><input name="c" value="4">';
  expect(JSON.parse(JSON.stringify(serialize(f)))).toEqual({ a: { b: '2' }, c: '4' });
});

test('bytes and number agree on empty input', () => {
  expect(bytes('')).toBe('');
  expect(number('')).toBe('');
  expect(bytes(null)).toBe('');
  expect(bytes('abc')).toBe('');
  expect(bytes(0)).not.toBe('');
});

test('built-in formatters: one Intl formatter per kind, locale and options, reused; a locale switch formats with the new one', () => {
  const made: string[] = [];
  const Real = Intl.DateTimeFormat;
  const spy = function (this: unknown, l?: string, o?: Intl.DateTimeFormatOptions) { made.push(`${l}|${JSON.stringify(o)}`); return new Real(l, o); } as unknown as typeof Intl.DateTimeFormat;
  let locale = 'en-US';
  configure({ locale: { get: () => locale, set: (l) => { locale = l; } } });
  Intl.DateTimeFormat = spy;
  try {
    const d = '2026-11-08T10:00:00Z';
    expect(date(d, 'long')).toBe(date(d, 'long'));
    date(d, 'short');
    expect(made).toEqual(['en-US|{"dateStyle":"long"}', 'en-US|{"dateStyle":"short"}']);
    locale = 'de-DE';
    expect(date(d, 'long')).toBe('8. November 2026');
    expect(made).toHaveLength(3);
    expect(number(1234.5)).toBe(number(1234.5));
    expect(relative('2026-11-07T10:00:00Z', d)).toBe('gestern');
  } finally {
    Intl.DateTimeFormat = Real;
    configure({ locale: null });
  }
});
