import { expect, test } from 'vitest';
import { render, mockRequests, mockStream } from '@tiaforge-ui/sinter/testing';
import page from './partial-events.html?raw';

test('an event with the item applies it; one without reloads the list', async () => {
  let people = [{ id: 1, name: 'Bob' }];
  const requests = mockRequests({ 'GET /api/people': () => people });
  const stream = mockStream();
  const { root, flush, settle } = await render(page, { requests, streams: { '/api/events': stream } });
  await settle();
  const names = () => [...root.querySelectorAll('li')].map((li) => li.textContent);
  const loads = () => requests.calls.filter((c) => c.path === '/api/people').length;

  stream.emit('person_updated', { person: { id: 2, name: 'Ada' } });
  await flush();
  expect(names()).toEqual(['Ada', 'Bob']);
  expect(loads()).toBe(1);                 // applied from the payload, no request

  people = [{ id: 1, name: 'Bobby' }, { id: 2, name: 'Ada' }];
  stream.emit('person_updated', { id: 1 }); // only the id: the second event reloads
  await settle();
  expect(loads()).toBe(2);
  expect(names()).toEqual(['Ada', 'Bobby']);
});
