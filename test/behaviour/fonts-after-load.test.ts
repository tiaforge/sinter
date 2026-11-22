// The early runtime's `fonts` (docs/first-paint.md#fonts-after-the-load): the stylesheet the build linked in
// `<noscript data-sn-fonts>` is added as a `<link rel=stylesheet>` once the window's `load` has fired, not before.
import { afterEach, expect, test } from 'vitest';
import { fonts } from '../../src/early.js';

/** a document still loading, with the build's `<noscript>`: its attributes repeat the link's href and crossorigin */
function page(href = '/assets/fonts-AbC123_x.css', cors = true) {
  const doc = document.implementation.createHTMLDocument('t');
  Object.defineProperty(doc, 'readyState', { value: 'loading', configurable: true });
  const n = doc.createElement('noscript');
  n.setAttribute('data-sn-fonts', href);
  if (cors) n.setAttribute('crossorigin', '');
  n.textContent = `<link rel="stylesheet"${cors ? ' crossorigin' : ''} href="${href}">`;
  doc.head.append(n, doc.createElement('link'));
  return doc;
}
const added = (doc: Document) => [...doc.querySelectorAll<HTMLLinkElement>('head > link[rel=stylesheet]')];

afterEach(() => { window.dispatchEvent(new Event('load')); localStorage.removeItem('sn-fonts'); });
// happy-dom loads no stylesheet: a link it does not load counts as loaded, with no error printed
(window as unknown as { happyDOM: { settings: { handleDisabledFileLoadingAsSuccess: boolean } } }).happyDOM.settings.handleDisabledFileLoadingAsSuccess = true;

test('the link goes in after `load`, right after the noscript, with its href and crossorigin', () => {
  const doc = page();
  fonts(doc);
  // parsed, DOMContentLoaded: still nothing
  doc.dispatchEvent(new Event('DOMContentLoaded'));
  expect(added(doc)).toHaveLength(0);
  window.dispatchEvent(new Event('load'));
  const [l] = added(doc);
  expect(l!.getAttribute('href')).toBe('/assets/fonts-AbC123_x.css');
  expect(l!.getAttribute('crossorigin')).toBe('');
  expect(l!.previousSibling).toBe(doc.querySelector('noscript'));
  // once: a later load event adds nothing
  window.dispatchEvent(new Event('load'));
  expect(added(doc)).toHaveLength(1);
});

test('no crossorigin when the noscript has none; a page already loaded gets it at once', () => {
  const doc = page('./assets/fonts-x.css?a=1&b=2', false);
  fonts(doc);
  window.dispatchEvent(new Event('load'));
  expect(added(doc)[0]!.getAttribute('href')).toBe('./assets/fonts-x.css?a=1&b=2');
  expect(added(doc)[0]!.hasAttribute('crossorigin')).toBe(false);
  const done = page();
  Object.defineProperty(done, 'readyState', { value: 'complete' });
  fonts(done);
  expect(added(done)).toHaveLength(1);
});

test('a page without the noscript is left alone', () => {
  const doc = document.implementation.createHTMLDocument('t');
  Object.defineProperty(doc, 'readyState', { value: 'loading' });
  fonts(doc);
  window.dispatchEvent(new Event('load'));
  expect(doc.querySelectorAll('link')).toHaveLength(0);
});

test('a reader who has had the fonts (the stylesheet noted in localStorage) gets the link at once; another stylesheet name does not count', () => {
  localStorage.setItem('sn-fonts', '/assets/fonts-AbC123_x.css');
  const doc = page();
  fonts(doc);
  expect(added(doc)).toHaveLength(1);
  const other = page('/assets/fonts-new.css');
  fonts(other);
  expect(added(other)).toHaveLength(0);
});
