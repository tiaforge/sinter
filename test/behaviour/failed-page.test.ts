// A page a server ended with its error text (sinter-axum: the data could not be fetched) has
// `<body data-sn-failed>`: the page module does not mount there, so it neither renders nor requests.
import { expect, test } from 'vitest';
import { parsed } from '../../src/runtime/env.js';

const doc = (body: string) => new DOMParser().parseFromString(`<!doctype html><html><head></head>${body}</html>`, 'text/html');

test('parsed() resolves on a parsed document, and never on one whose body is marked failed', async () => {
  const settled = (p: Promise<void>) => Promise.race([p.then(() => 'resolved'), new Promise((r) => setTimeout(() => r('pending'), 30))]);
  expect(await settled(parsed(doc('<body><main></main></body>')))).toBe('resolved');
  expect(await settled(parsed(doc('<body data-sn-failed><p>Error, please retry later.</p></body>')))).toBe('pending');
});
