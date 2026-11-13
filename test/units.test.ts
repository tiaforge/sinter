// Small pure functions of the runtime.
import { expect, test } from 'vitest';
import { withParams } from '../src/runtime/app.js';
import { lists, readUrl } from '../src/runtime/url.js';
import { requests } from '../src/early.js';
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

test('a calendar date is the same day for every visitor: formatted in UTC, where it was parsed; a moment in the visitor\'s zone', () => {
  const Real = Intl.DateTimeFormat;
  const made: string[] = [];
  Intl.DateTimeFormat = function (this: unknown, l?: string, o?: Intl.DateTimeFormatOptions) { made.push(JSON.stringify(o)); return new Real(l, { ...o, ...(o?.timeZone ? {} : { timeZone: 'America/Los_Angeles' }) }); } as unknown as typeof Intl.DateTimeFormat;
  // (a locale no other test formats with: formatters are cached)
  configure({ locale: { get: () => 'en-GB', set: () => {} } });
  try {
    // midnight UTC is the evening before in Los Angeles: a calendar date keeps its day
    expect(date('2026-11-11', 'long')).toBe('11 November 2026');
    expect(date('2026-11-11T00:00:00Z', 'long')).toBe('10 November 2026');
    expect(made).toEqual(['{"dateStyle":"long","timeZone":"UTC"}', '{"dateStyle":"long"}']);
  } finally {
    Intl.DateTimeFormat = Real;
    configure({ locale: null });
  }
});

test('readUrl: an array parameter is every value of its name ([] when none); others the last; the early requests read it the same way', () => {
  const href = 'http://x/?tag=a&q=1&tag=b&q=2&constructor=x';
  expect(lists(href, ['tag', 'f'], readUrl(href))).toEqual({ tag: ['a', 'b'], f: [], q: '2' });
  expect(readUrl('http://x/a/s?slug=q', ['/a/:slug'])).toEqual({ slug: 's' });
  const r = requests(undefined, () => ({ now: () => 0, href: () => 'http://x/?tag=a&tag=b', fetch: () => Promise.reject() }));
  expect(r.read('$url', undefined, (h, u) => lists(h, ['tag'], u))).toEqual({ tag: ['a', 'b'] });
});
