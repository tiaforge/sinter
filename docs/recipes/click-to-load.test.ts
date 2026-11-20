import { expect, test } from 'vitest';
import { render, mockRequests } from '@tiaforge-ui/sinter/testing';
import page from './click-to-load.html?raw';

test('nothing loads until the click; refresh() loads again', async () => {
  const requests = mockRequests({ 'GET /api/posts/7/comments': () => ({ comments: [{ id: 1, body: 'First' }] }) });
  const { root, settle } = await render(page, { requests });
  await settle();
  const loads = () => requests.calls.filter((c) => c.path === '/api/posts/7/comments').length;
  const [show, reload] = root.querySelectorAll('button');
  expect(loads()).toBe(0);

  show.click();
  await settle();
  expect(loads()).toBe(1);
  expect([...root.querySelectorAll('li')].map((li) => li.textContent)).toEqual(['First']);

  reload.click();
  await settle();
  expect(loads()).toBe(2);
});
