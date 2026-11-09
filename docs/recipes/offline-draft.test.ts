import { afterEach, expect, test } from 'vitest';
import { configure } from '@tiaforge-ui/sinter';
import { retry } from '@tiaforge-ui/sinter/retry';
import { render, mockRequests } from '@tiaforge-ui/sinter/testing';
import page from './offline-draft.html?raw';

afterEach(() => configure({ sessionProbe: null, retry: null }));

test('a draft typed while offline is sent once the connection is back, with one key', async () => {
  configure({ sessionProbe: '/api/user', retry: retry({ policies: { drafts: { backoff: ['1s', '30s'] } } }) });
  let online = false;
  const requests = mockRequests({
    'GET /api/notes/7': { id: 7, title: 'Plan', body: '' },
    'GET /api/user': () => (online ? { name: 'me' } : { status: 503 }),
    'PUT /api/notes/7': (c) => { if (!online) throw new TypeError('Failed to fetch'); return c.body; },
  });
  const { root, settle, advance } = await render(page, { requests });
  await settle();
  const form = root.querySelector('form')!, title = root.querySelector('input')!;

  title.value = 'Plan for Monday';
  title.dispatchEvent(new Event('input', { bubbles: true }));
  await advance(500);    // the debounce
  await settle();
  expect(form.getAttribute('aria-busy')).toBe('true');   // waiting: "Not saved yet" shows

  await advance(1000);   // the probe fails (offline): wait longer
  await settle();
  online = true;
  await advance(2000);   // the probe answers: sent again
  await settle();
  const puts = requests.calls.filter((c) => c.method === 'PUT');
  expect(puts).toHaveLength(2);
  expect(puts[1]!.body).toEqual({ title: 'Plan for Monday', body: '' });
  expect(puts[1]!.headers['idempotency-key']).toBe(puts[0]!.headers['idempotency-key']);
  expect(form.hasAttribute('aria-busy')).toBe(false);
});
