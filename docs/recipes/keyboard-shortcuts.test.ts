import { expect, test } from 'vitest';
import { render, mockRequests } from '@tiaforge-ui/sinter/testing';
import page from './keyboard-shortcuts.html?raw';

const key = (el: Element, k: string, init: KeyboardEventInit = {}) =>
  el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...init }));

test('j/k move the cursor, Ctrl+Space marks, Enter opens, Escape closes; keys typed in the search field stay there', async () => {
  const requests = mockRequests({ 'GET /api/messages': { messages: [{ id: 1, subject: 'Hello' }, { id: 2, subject: 'Lunch?' }] } });
  const { root, flush, settle } = await render(page, { requests });
  await settle();
  const body = root /* the <body> */, rows = () => [...root.querySelectorAll('li')];
  key(body, 'j');
  key(body, ' ', { ctrlKey: true });
  key(body, 'Enter');
  await flush();
  expect(rows().map((li) => li.className)).toEqual(['', 'cursor marked']);
  expect(root.querySelector('article')!.textContent).toBe('Lunch?');

  key(root.querySelector('input')!, 'k');  // typing a k
  key(body, 'Escape');
  await flush();
  expect(rows()[1]!.className).toBe('cursor marked');
  expect(root.querySelector('article')!.hidden).toBe(true);

  key(body, '/');
  expect(root.ownerDocument.activeElement).toBe(root.querySelector('input'));
});
