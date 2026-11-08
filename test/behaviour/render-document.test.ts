// @vitest-environment jsdom
// render() with full documents under jsdom, which parses as the spec says (Caley's tests run in
// it): an <html> start tag inside innerHTML does not reach the document's own <html> element.
import { expect, test } from 'vitest';
import { render } from '../../src/testing/index.js';

test('render() takes the <html> attributes from the element, not from an <html> mentioned before it', async () => {
  // Caley's calendar page explains its state in a comment before the real tag
  const { root, flush } = await render(`<!doctype html>
<!-- view: 'week' or 'month' (on <html> so the body's shortcuts can read it). -->
<html lang="de" data-sn-state="{ view: 'month' }"><head><title>x</title></head><body>
<p data-sn-text="view"></p><button data-sn-on-click="view = 'week'">week</button></body></html>`);
  expect(document.documentElement.getAttribute('lang')).toBe('de');
  expect(root.querySelector('p')!.textContent).toBe('month');
  root.querySelector('button')!.click();
  await flush();
  expect(root.querySelector('p')!.textContent).toBe('week');
  // nothing of the comment leaks into the page, and the page module's placeholder script is gone
  expect(document.body.textContent).not.toContain('shortcuts');
  expect(document.querySelector('script[src="about:blank"]')).toBeNull();
});
