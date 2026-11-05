import { expect, test } from 'vitest';
import { render, mockRequests } from '@tiaforge-ui/sinter/testing';
import page from './list-filter.html?raw';


test('filters the list as you type', async () => {
  const requests = mockRequests({ 'GET /api/people': { people: [{ id: 1, name: 'Bob' }, { id: 2, name: 'Ada' }] } });
  const { root, flush, settle } = await render(page, { requests });
  await settle();
  expect([...root.querySelectorAll('li')].map((li) => li.textContent)).toEqual(['Ada', 'Bob']);

  const input = root.querySelector('input')!;
  input.value = 'ad';
  input.dispatchEvent(new Event('input', { bubbles: true }));
  await flush();
  expect([...root.querySelectorAll('li')].map((li) => li.textContent)).toEqual(['Ada']);
});
