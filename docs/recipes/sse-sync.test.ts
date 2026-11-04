import { expect, test } from 'vitest';
import { render, mockRequests, mockStream } from '@tiaforge/sinter/testing';
import page from './sse-sync.html?raw';


test('applies server events to the list', async () => {
  const requests = mockRequests({ 'GET /api/people': [{ id: 1, name: 'Bob' }] });
  const stream = mockStream();
  const { root, flush, settle } = await render(page, { requests, streams: { '/api/events': stream } });
  await settle();

  stream.emit('person_updated', { person: { id: 2, name: 'Ada' } });
  stream.emit('person_removed', { id: 1 });
  await flush();
  expect([...root.querySelectorAll('li')].map((li) => li.textContent)).toEqual(['Ada']);
});
