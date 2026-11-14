import { expect, test } from 'vitest';
import { render, mockRequests } from '@tiaforge-ui/sinter/testing';
import page from './url-filter.html?raw';

const api = () => mockRequests({
  'GET /api/posts': (call) => ({ posts: new URL(call.url, 'http://x').searchParams.getAll('tag').map((t, i) => ({ id: i, title: t })) }),
});

test('each box is an entry; the tags go to the URL and the request as repeated keys; Clear removes them', async () => {
  const requests = api();
  const { root, settle, url, history } = await render(page, { requests, url: 'http://localhost/?tag=go' });
  await settle();
  const boxes = root.querySelectorAll<HTMLInputElement>('input');
  expect([...boxes].map((b) => b.checked)).toEqual([true, false, false]);
  boxes[1]!.click();
  await settle();
  expect(url()).toBe('http://localhost/?tag=go&tag=rust');
  expect(requests.calls.at(-1)!.url).toBe('/api/posts?tag=go&tag=rust');
  expect([...root.querySelectorAll('li')].map((li) => li.textContent)).toEqual(['go', 'rust']);
  root.querySelector('button')!.click();
  await settle();
  expect(url()).toBe('http://localhost/');
  expect(root.querySelector('button')!.hidden).toBe(true);
  expect(history()).toHaveLength(3);
});
