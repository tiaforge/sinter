import { expect, test } from 'vitest';
import { render, mockRequests, mockStream } from '@tiaforge-ui/sinter/testing';
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

test('a removed person closes the dialog that shows them', async () => {
  const requests = mockRequests({ 'GET /api/people': [{ id: 1, name: 'Bob' }, { id: 2, name: 'Ada' }] });
  const stream = mockStream();
  const { root, flush, settle } = await render(page, { requests, streams: { '/api/events': stream } });
  await settle();
  root.querySelector('button')!.click();   // Ada
  await flush();
  const dialog = root.querySelector('dialog')!;
  expect(dialog.open).toBe(true);

  stream.emit('person_removed', { id: 1 });
  await flush();
  expect(dialog.open).toBe(true);
  stream.emit('person_removed', { id: 2 });
  await flush();
  expect(dialog.open).toBe(false);
});
