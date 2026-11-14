import { expect, test } from 'vitest';
import { render, mockRequests } from '@tiaforge-ui/sinter/testing';
import page from './url-search.html?raw';

const api = () => mockRequests({
  'GET /api/search': (call) => {
    const q = new URL(call.url, 'http://x').searchParams;
    return { hits: [{ id: 1, title: `${q.get('q')} (${q.get('sort') || 'best'})` }] };
  },
});
const type = (el: HTMLInputElement, v: string) => { el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })); };

test('typing writes the URL once per pause; a select is an entry of its own; a shared link restores both', async () => {
  const requests = api();
  const { root, settle, flush, history } = await render(page, { requests });
  const field = root.querySelector('input')!;
  for (const v of ['s', 'si', 'sinter']) { type(field, v); await flush(); }
  await settle();
  expect(history()).toEqual(['http://localhost/', 'http://localhost/?q=sinter']);
  expect(requests.calls.map((c) => c.url)).toEqual(['/api/search?q=sinter']);
  const sort = root.querySelector('select')!;
  sort.value = 'new'; sort.dispatchEvent(new Event('change', { bubbles: true }));
  await settle();
  expect(history()).toEqual(['http://localhost/', 'http://localhost/?q=sinter', 'http://localhost/?q=sinter&sort=new']);

  const shared = await render(page, { requests: api(), url: 'http://localhost/?q=sinter&sort=new' });
  await shared.settle();
  expect(shared.root.querySelector('input')!.value).toBe('sinter');
  expect(shared.root.querySelector('li')!.textContent).toBe('sinter (new)');
});
