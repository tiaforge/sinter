// Small pure functions of the runtime.
import { expect, test } from 'vitest';
import { serialize, withParams } from '../src/runtime/app.js';
import { bytes, number } from '../src/runtime/helpers.js';

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
