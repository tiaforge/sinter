import { expect, test } from 'vitest';
import { render, mockRequests } from '@tiaforge/sinter/testing';
import page from './pagination.html?raw';

const all = [5, 4, 3, 2, 1].map((id) => ({ id, subject: `m${id}` }));

test('moves to the next page with a cursor', async () => {
  const requests = mockRequests({
    'GET /api/messages': (call) => {
      const q = new URL(call.url, 'http://x').searchParams;
      const before = Number(q.get('before') ?? Infinity);
      const items = q.get('direction') === 'next' ? all.filter((m) => m.id < before) : all;
      return { messages: items.slice(0, Number(q.get('limit'))), total: all.length };
    },
  });
  const { root, settle } = await render(page, { requests });
  await settle();
  expect(root.querySelector('span')!.textContent).toBe('1–2 of 5');

  root.querySelector<HTMLButtonElement>('nav button:last-of-type')!.click();
  await settle();
  expect([...root.querySelectorAll('li')].map((li) => li.textContent)).toEqual(['m3', 'm2']);
  expect(root.querySelector('span')!.textContent).toBe('3–4 of 5');
  expect(requests.calls.at(-1)!.url).toBe('/api/messages?before=4&limit=2&direction=next');
});
