import { expect, test } from 'vitest';
import { render, mockRequests } from '@tiaforge-ui/sinter/testing';
import * as helpers from './pane-shortcuts.helpers.js';
import page from './pane-shortcuts.html?raw';

const key = (el: Element, k: string) => el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));

test('j/k move the pane\'s cursor with focus on <body>, in the nav or in the pane; typed into the search field, they stay there', async () => {
  const requests = mockRequests({ 'GET /api/messages': { messages: [1, 2, 3].map((id) => ({ id, subject: `m${id}` })) } });
  const { root, flush, settle } = await render(page, { requests, helpers });
  await settle();
  const at = () => [...root.querySelectorAll('li')].findIndex((li) => li.classList.contains('cursor'));
  const body = root /* the <body> */;
  key(body, 'j');
  key(root.querySelector('nav a')!, 'j');
  await flush();
  expect(at()).toBe(2);
  key(root.querySelector('li')!, 'k');
  key(root.querySelector('input')!, 'k');  // typing a k
  key(body, 'j');
  key(body, 'j');                           // past the end: stays on the last row
  await flush();
  expect(at()).toBe(2);
  key(body, 'k');
  key(body, 'k');
  await flush();
  expect(at()).toBe(0);
});
