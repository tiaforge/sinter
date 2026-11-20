// The built-in formatters in the first paint (docs/first-paint.md): a date or number over embedded data is written
// by the early file, and the page module writes the same text at mount, so nothing changes after the paint
// (RealWorld's article: the date under the author, which made the buttons beside it wrap at mount).
import { afterEach, expect, test, vi } from 'vitest';
import { firstPaint, render } from '../../src/testing/index.js';

const PAGE = `<!doctype html><html><head><script type="application/json" data-sn-resource="a">{"a":{"at":"2026-01-26T10:00:00Z","n":1234.5}}</script></head><body>
  <sn-resource name="a" src="/api/a" items="a"></sn-resource>
  <p id="d" data-sn-text="date(a.at, 'long')"></p>
  <p id="n" data-sn-text="number(a.n)"></p>
  <p id="r" data-sn-text="relative(a.at)"></p>
</body></html>`;
const text = (id: string) => document.getElementById(id)!.textContent;

afterEach(() => { vi.unstubAllGlobals(); });

test('date() and number() are in the first paint, as the page module writes them; relative() waits for it (the clock)', async () => {
  const want = new Intl.DateTimeFormat(undefined, { dateStyle: 'long' }).format(new Date('2026-01-26T10:00:00Z'));
  await firstPaint(PAGE);
  expect(text('d')).toBe(want);
  expect(text('n')).toBe(new Intl.NumberFormat().format(1234.5));
  expect(text('r')).toBe('');
  let early: Node | null = null;
  const { settle } = await render(PAGE, { firstPaint: { afterEarly: () => { early = document.getElementById('d')!.firstChild; } } });
  await settle();
  // the same text, and the same node: nothing was written over it
  expect(text('d')).toBe(want);
  expect(document.getElementById('d')!.firstChild).toBe(early);
  expect(text('r')).not.toBe('');
});
