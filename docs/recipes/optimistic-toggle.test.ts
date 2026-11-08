import { expect, test } from 'vitest';
import { render, mockRequests } from '@tiaforge-ui/sinter/testing';
import page from './optimistic-toggle.html?raw';


test('flags at once and rolls back when the server refuses', async () => {
  const requests = mockRequests({
    'GET /api/messages': [{ id: 1, subject: 'Hi', is_flagged: false }],
    'PATCH /api/messages/1': { status: 500 },
  });
  const { root, flush, settle } = await render(page, { requests });
  await settle();
  const star = root.querySelector('button')!;

  star.click();
  await flush();
  expect(star.getAttribute('aria-pressed')).toBe('true');   // optimistic

  await settle();
  expect(star.getAttribute('aria-pressed')).toBe('false');  // rolled back
});

test('keeps the flag when the server accepts it', async () => {
  const requests = mockRequests({
    'GET /api/messages': [{ id: 1, subject: 'Hi', is_flagged: false }],
    'PATCH /api/messages/1': null,
  });
  const { root, settle } = await render(page, { requests });
  await settle();
  const star = root.querySelector('button')!;

  star.click();
  await settle();
  expect(star.getAttribute('aria-pressed')).toBe('true');   // committed: no flip back
});
