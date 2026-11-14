// The build's evaluator for indicator conditions (src/compiler/status-eval.ts): known fields, or null.
import { expect, test } from 'vitest';
import { shows } from '../../src/compiler/status-eval.js';

const at = (code: string, loading: boolean, rows: unknown[] = []) => shows(`($) => (${code})`, ['c'], { loading }, rows);

test('the status and the rows, as a branch reads them', () => {
  expect(at('$.$meta.c.loading && !$.$r.c?.length', true)).toBe(true);
  expect(at('$.$meta.c.loading && !$.$r.c?.length', true, [{}])).toBe(false);
  expect(at('$.$meta.c.error', true)).toBe(false);
  expect(at('!$.$meta.c.loading', true)).toBe(false);
  expect(at('$.$meta.c.loadedAt == null ? "a" : ""', true)).toBe(true);
  expect(at('$.$meta.c.pending === 0 && $.$meta.c.loading', true)).toBe(true);
});

test('anything else: unknown, never run', () => {
  expect(at('$.$meta.c.loading && $.open', true)).toBe(null);
  expect(at('globalThis.boom()', true)).toBe(null);
  // a known false side decides an && whatever the other
  expect(at('$.$meta.c.error && $.open', true)).toBe(false);
  expect(at('$.$meta.c.loading || $.open', true)).toBe(true);
});
