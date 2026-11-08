import { describe, expect, test } from 'vitest';
import { render, mockRequests } from '@tiaforge-ui/sinter/testing';
import * as helpers from './row-select.helpers.js';
import page from './row-select.html?raw';

const { rowClick, noSelection } = helpers;

// the helper: pure, so tested with plain values
describe('rowClick', () => {
  const keys = ['a', 'b', 'c', 'd'];
  const click = (init: Partial<MouseEvent> = {}) => ({ ctrlKey: false, metaKey: false, shiftKey: false, ...init }) as MouseEvent;
  test('a click selects only that row and makes it the anchor', () => {
    expect(rowClick(click(), { keys: ['a', 'c'], anchor: 'a' }, 'b', keys)).toEqual({ keys: ['b'], anchor: 'b' });
  });
  test('Ctrl or Cmd adds or removes the row, in display order', () => {
    expect(rowClick(click({ ctrlKey: true }), { keys: ['c'], anchor: 'c' }, 'a', keys)).toEqual({ keys: ['a', 'c'], anchor: 'a' });
    expect(rowClick(click({ metaKey: true }), { keys: ['a', 'c'], anchor: 'a' }, 'c', keys)).toEqual({ keys: ['a'], anchor: 'c' });
  });
  test('Shift selects from the anchor, in either direction; with Ctrl it adds', () => {
    expect(rowClick(click({ shiftKey: true }), { keys: ['b'], anchor: 'b' }, 'd', keys)).toEqual({ keys: ['b', 'c', 'd'], anchor: 'b' });
    expect(rowClick(click({ shiftKey: true }), { keys: ['c'], anchor: 'c' }, 'a', keys)).toEqual({ keys: ['a', 'b', 'c'], anchor: 'c' });
    expect(rowClick(click({ shiftKey: true, ctrlKey: true }), { keys: ['a', 'd'], anchor: 'd' }, 'c', keys)).toEqual({ keys: ['a', 'c', 'd'], anchor: 'd' });
  });
  test('Shift without an anchor (or a removed one) is a plain click', () => {
    expect(rowClick(click({ shiftKey: true }), noSelection(), 'c', keys)).toEqual({ keys: ['c'], anchor: 'c' });
    expect(rowClick(click({ shiftKey: true }), { keys: ['x'], anchor: 'x' }, 'c', keys)).toEqual({ keys: ['c'], anchor: 'c' });
  });
});

// the page: the handler applies the helper's result
test('click, Ctrl+click and Shift+click select rows', async () => {
  const requests = mockRequests({ 'GET /api/files': { files: ['a', 'b', 'c', 'd'].map((id) => ({ id, name: id.toUpperCase() })) } });
  const { root, flush, settle } = await render(page, { requests, helpers });
  await settle();
  const rows = () => [...root.querySelectorAll('li')];
  const click = (i: number, init: MouseEventInit = {}) => rows()[i]!.dispatchEvent(new MouseEvent('click', { bubbles: true, ...init }));
  const selected = () => rows().filter((li) => li.getAttribute('aria-selected') === 'true').map((li) => li.textContent);

  click(1);
  click(3, { shiftKey: true });
  await flush();
  expect(selected()).toEqual(['B', 'C', 'D']);
  click(0, { ctrlKey: true });
  await flush();
  expect(selected()).toEqual(['A', 'B', 'C', 'D']);
  expect(root.querySelector('p')!.textContent).toBe('4 selected');
  root.querySelector('button')!.click();
  await flush();
  expect(selected()).toEqual([]);
});
