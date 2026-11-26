// The attributes a component's tag takes (`callerAttribute`): every one in the vocabulary that a caller
// writes, so a rename in the vocabulary that misses this list fails here, not on a component's tag.
import { expect, test } from 'vitest';
import { callerAttribute } from '../../src/compiler/components.js';
import { ATTRIBUTES } from '../../src/compiler/vocabulary.js';

const CALLER = ['with', 'model', 'persist', 'early', 'class', 'attr', 'href', 'style', 'show', 'transition', 'post', 'put', 'patch', 'delete', 'call',
  'body', 'trigger', 'debounce', 'concurrency', 'optimistic', 'then', 'catch', 'confirm', 'when', 'encoding', 'write-through', 'retry'];

test('a component\'s tag takes the caller\'s attributes of the vocabulary, and handlers', () => {
  const names = new Set(ATTRIBUTES.map((a) => a.name));
  for (const n of CALLER) {
    expect(names.has(n), `data-sn-${n} is in the vocabulary`).toBe(true);
    expect(callerAttribute(`data-sn-${n}`), `data-sn-${n}`).toBe(true);
  }
  expect(callerAttribute('data-sn-on-click')).toBe(true);
  expect(callerAttribute('data-sn-debounce-input')).toBe(true);
  for (const n of ATTRIBUTES.map((a) => a.name).filter((n) => !CALLER.includes(n))) expect(callerAttribute(`data-sn-${n}`), `data-sn-${n}`).toBe(false);
});
