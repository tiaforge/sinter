import { expect, test } from 'vitest';
import { render, mockRequests } from '@tiaforge/sinter/testing';
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
