// An app that sets no locale: the page's literal `<html lang>` is the locale of the built-in formatters and `$locale`
// in the browser, in the first paint (the early file) and in the page module alike; without one, the engine's default.
// (A real build's head scripts: test/vite/page-lang.test.ts.)
import { expect, test } from 'vitest';
import { configure } from '../../src/index.js';
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

test('dev warning 35: text formatted in <html lang> at build while the app\'s locale source says another', async () => {
  const fixed = page('<html lang="de">').replace('<p id="l"', '<p id="c" data-sn-state="{ day: \'2026-11-11\' }" data-sn-text="date(day, \'long\')"></p><p id="l"');
  // the app's source, set after the build looked (as one in a module out of its sight)
  const { settle, warnings } = await render(fixed, { strict: false, firstPaint: { afterEarly: () => configure({ locale: { get: () => 'fr', set() {} } }) } });
  await settle();
  try {
    expect(text('c')).toBe('11. November 2026');
    expect(warnings().map((w) => w.message).join('\n')).toContain("in its `<html lang>` (`de`), but the app's locale is `fr`");
  } finally { configure({ locale: null }); }
  // the build saw the app's source: nothing formatted at build, no warning
  configure({ locale: { get: () => 'fr', set() {} } });
  try {
    const again = await render(fixed, { strict: false });
    await again.settle();
    expect(text('c')).toBe('11 novembre 2026');
    expect(again.warnings().some((w) => w.message.includes('`<html lang>`'))).toBe(false);
  } finally { configure({ locale: null }); }
});

test('a test\'s own locale source survives a render with messages (render() drops only what it set)', async () => {
  configure({ locale: { get: () => 'fr', set() {} } });
  try {
    await render('<!doctype html><html><body><p id="m" data-sn-text="m.hi()"></p></body></html>', { messages: { de: { hi: 'Hallo' } } });
    const { settle } = await render(page('<html lang="de">'));
    await settle();
    expect(text('l')).toBe('fr');
  } finally { configure({ locale: null }); }
});
