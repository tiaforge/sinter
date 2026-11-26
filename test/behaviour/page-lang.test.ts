// An app that sets no locale: the page's literal `<html lang>` is the locale of the built-in formatters and `$locale`
// in the browser, in the first paint (the early file) and in the page module alike; without one, the engine's default.
// (A real build's head scripts: test/vite/page-lang.test.ts.)
import { expect, test } from 'vitest';
import { firstPaint, render } from '../../src/testing/index.js';

const page = (html: string) => `<!doctype html>${html}<head><script type="application/json" data-sn-resource="a">{"a":{"at":"2026-01-26T10:00:00Z","n":1234.5}}</script></head><body>
  <sn-resource name="a" src="/api/a" select="a"></sn-resource>
  <p id="d" data-sn-text="date(a.at, 'long')"></p>
  <p id="n" data-sn-text="number(a.n)"></p>
  <p id="l" data-sn-text="$locale ?? ''"></p>
</body></html>`;
const text = (id: string) => document.getElementById(id)!.textContent;
const long = (l: string | undefined) => new Intl.DateTimeFormat(l, { dateStyle: 'long' }).format(new Date('2026-01-26T10:00:00Z'));

test('<html lang="de">: the first paint and the live page write the date and number in German; $locale is "de"', async () => {
  await firstPaint(page('<html lang="de">'));
  expect(text('d')).toBe(long('de'));
  expect(text('n')).toBe('1.234,5');
  const { settle } = await render(page('<html lang="de">'), { firstPaint: true });
  await settle();
  expect(text('d')).toBe(long('de'));
  expect(text('n')).toBe('1.234,5');
  expect(text('l')).toBe('de');
});

test('no lang: the engine\'s default, as before (and the last page\'s language does not carry over)', async () => {
  await render(page('<html lang="de">'));
  const { settle } = await render(page('<html>'));
  await settle();
  expect(text('d')).toBe(long(undefined));
  expect(text('n')).toBe(new Intl.NumberFormat().format(1234.5));
  expect(text('l')).toBe('');
});

test('a locale source the app configures wins over <html lang>, and does not carry over to the next render', async () => {
  const { settle } = await render(page('<html lang="de">'), { locale: 'fr' });
  await settle();
  expect(text('d')).toBe(long('fr'));
  expect(text('l')).toBe('fr');
  const next = await render(page('<html>'));
  await next.settle();
  expect(text('d')).toBe(long(undefined));
  expect(text('l')).toBe('');
});
