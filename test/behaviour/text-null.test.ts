// @vitest-environment jsdom
// `data-sn-text` over null or undefined renders empty text, in the early script, in the page module and over
// constants, so a binding needs no `?? ''` or `x ? x.y : ''`; `sinter check` takes a nullable field as it is.
import { expect, test } from 'vitest';
import { checkPage } from '../../src/check/index.js';
import { render } from '../../src/testing/index.js';

const page = (data: unknown) => `<!doctype html><html><head><script type="application/json" data-sn-resource="p">${JSON.stringify(data)}</script></head><body>
  <sn-resource name="p" src="/api/p"></sn-resource><sn-resource name="q" src="/api/q" when="false"></sn-resource>
  <p id="bio" data-sn-text="p.bio"></p><p id="gone" data-sn-text="p.gone"></p><p id="q" data-sn-text="q?.title"></p>
  <div data-sn-state="{ none: null }"><p id="c" data-sn-text="none"></p><template data-sn-text="none"></template></div></body></html>`;
const texts = (root: ParentNode) => ['bio', 'gone', 'q', 'c'].map((id) => root.querySelector(`#${id}`)!.textContent);

test('null and undefined are empty text: early, at takeover and over constants', async () => {
  let early: (string | null)[] = [];
  const { root, settle } = await render(page({ bio: null }), { firstPaint: { afterEarly: () => { early = texts(document); } } });
  await settle();
  expect(early).toEqual(['', '', '', '']);
  expect(texts(root)).toEqual(['', '', '', '']);
  expect(root.querySelector('div')!.textContent).toBe('');
});

test('sinter check: a nullable field and an optional chain in data-sn-text need no fallback', () => {
  const html = `<html><body><sn-resource name="p" src="/api/p" type="{ bio: string | null }"></sn-resource>
    <sn-resource name="t" src="/api/t" type="{ title: string }"></sn-resource>
    <p data-sn-text="p.bio"></p><h1 data-sn-text="t?.title"></h1></body></html>`;
  expect(checkPage(html)).toEqual([]);
});
