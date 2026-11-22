// attrAllowed and styleAllowed: a component script that builds elements itself is held to the rules of data-sn-attr
// and data-sn-style, the app's configured URL schemes included.
import { afterEach, expect, test } from 'vitest';
import { attrAllowed, configure, styleAllowed } from '../src/index.js';

afterEach(() => configure({ urlSchemes: [] }));

test('URL attributes: allowed schemes, relative URLs by the page, data: and blob: only as media sources', () => {
  const a = document.createElement('a'), img = document.createElement('img');
  expect(attrAllowed(a, 'href', 'https://example.com/')).toBe(true);
  expect(attrAllowed(a, 'href', 'mailto:x@example.com')).toBe(true);
  expect(attrAllowed(a, 'href', '/inbox')).toBe(true);
  for (const bad of ['javascript:alert(1)', ' JaVa\tScRiPt:alert(1)', 'vbscript:x', 'data:text/html,<b>x</b>']) expect(attrAllowed(a, 'href', bad), bad).toBe(false);
  expect(attrAllowed(img, 'src', 'data:image/png;base64,AAAA')).toBe(true);
  expect(attrAllowed(a, 'href', 'data:image/png;base64,AAAA')).toBe(false);
  expect(attrAllowed(img, 'srcset', 'a.png 1x, javascript:x 2x')).toBe(false);
  // not a URL attribute: the caller decides which attributes an element may have
  expect(attrAllowed(a, 'title', 'javascript:x')).toBe(true);
});

test('the app\'s configured schemes apply, as they do to data-sn-attr', () => {
  const a = document.createElement('a');
  expect(attrAllowed(a, 'href', 'webcal://example.com/cal.ics')).toBe(false);
  configure({ urlSchemes: ['webcal'] });
  expect(attrAllowed(a, 'href', 'webcal://example.com/cal.ics')).toBe(true);
  configure({ urlSchemes: ['javascript'] });
  expect(attrAllowed(a, 'href', 'javascript:x')).toBe(false);
});

test('style values that could load a URL are refused', () => {
  expect(styleAllowed('red')).toBe(true);
  expect(styleAllowed('1px solid rgb(0, 0, 0)')).toBe(true);
  for (const bad of ['url(https://t.example/p.gif)', 'image-set("a.png" 1x)', '\\75 rl(x)']) expect(styleAllowed(bad), bad).toBe(false);
});
