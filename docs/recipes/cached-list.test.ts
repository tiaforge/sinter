import { expect, test } from 'vitest';
import { render, mockRequests, memoryStorage } from '@tiaforge-ui/sinter/testing';
import page from './cached-list.html?raw';

const subjects = (root: HTMLElement) => [...root.querySelectorAll('li')].map((li) => li.textContent);

test('the next page load shows the cached list while it revalidates', async () => {
  // one tab: the same sessionStorage for both page loads
  const session = memoryStorage();
  const first = await render(page, { session, requests: mockRequests({
    'GET /api/messages': [{ id: 1, subject: 'Welcome', date: '2026-01-01' }],
  }) });
  await first.settle();

  const { root, settle } = await render(page, { session, requests: mockRequests({
    'GET /api/messages': [{ id: 2, subject: 'Lunch?', date: '2026-01-02' }, { id: 1, subject: 'Welcome', date: '2026-01-01' }],
  }) });
  expect(subjects(root)).toEqual(['Welcome']);                    // cached, before any response
  expect(root.querySelector('p')!.hidden).toBe(false);            // "Updating…"

  await settle();
  expect(subjects(root)).toEqual(['Lunch?', 'Welcome']);
  expect(root.querySelector('p')!.hidden).toBe(true);
});
