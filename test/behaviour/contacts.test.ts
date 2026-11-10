import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, test } from 'vitest';
import { render, mockRequests, mockStream } from '../../src/testing/index.js';

const dir = resolve(__dirname, '../fixtures');
const page = readFileSync(`${dir}/contacts.html`, 'utf8');
const ada = { account_id: 'a', uid: '1', addressbook_href: '/ab', fn_name: 'Ada', org: '', emails: [], phones: [], addresses: [] };

test('delete is optimistic and rolls back on failure', async () => {
  const requests = mockRequests({
    'GET /api/contacts': { addressbooks: [], contacts: [ada] },
    'DELETE /api/contact': { status: 500 },
  });
  const stream = mockStream();
  const { root, flush, settle } = await render(page, { requests, streams: { '/api/events/stream': stream } });
  await settle();
  expect(root.querySelectorAll('li')).toHaveLength(1);

  root.querySelector<HTMLElement>('li button:last-of-type')!.click();
  await flush();                                   // optimistic layer applied
  expect(root.querySelectorAll('li')).toHaveLength(0);

  await settle();                                  // request failed, layer dropped
  expect(root.querySelectorAll('li')).toHaveLength(1);
  expect(requests.calls.at(-1)!.body).toEqual({ account_id: 'a', uid: '1', addressbook_href: '/ab' });
});
