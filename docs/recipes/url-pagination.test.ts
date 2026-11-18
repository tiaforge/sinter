import { expect, test } from 'vitest';
import { render, mockRequests } from '@tiaforge-ui/sinter/testing';
import page from './url-pagination.html?raw';

const all = [1, 2, 3, 4, 5].map((n) => ({ slug: `a${n}`, title: `A${n}` }));
const api = () => mockRequests({
  'GET /api/articles': (call) => {
    const q = new URL(call.url, 'http://x').searchParams, o = Number(q.get('offset')), n = Number(q.get('limit'));
    return { articles: all.slice(o, o + n), count: all.length };
  },
});
const titles = (root: HTMLElement) => [...root.querySelectorAll('li')].map((li) => li.textContent);

test('a shared link opens its page; moving writes the URL; Back goes to the page before', async () => {
  const { root, settle, url, back } = await render(page, { requests: api(), url: 'http://localhost/?page=2' });
  await settle();
  expect(titles(root)).toEqual(['A3', 'A4']);
  root.querySelector<HTMLButtonElement>('nav > button:last-of-type')!.click();
  await settle();
  expect(url()).toBe('http://localhost/?page=3');
  expect(titles(root)).toEqual(['A5']);
  expect(root.querySelector('a[aria-current]')!.textContent).toBe('3');
  await back();
  await settle();
  expect(titles(root)).toEqual(['A3', 'A4']);
});

test('a page link stays on the page: a history entry, and the list loads that page', async () => {
  const requests = api();
  const { root, settle, url, historyWrites } = await render(page, { requests });
  await settle();
  const before = requests.calls.length;
  root.querySelector<HTMLAnchorElement>('a[href="?page=3"]')!.click();
  await settle();
  expect(url()).toBe('http://localhost/?page=3');
  expect(titles(root)).toEqual(['A5']);
  expect(root.querySelector('a[aria-current]')!.textContent).toBe('3');
  expect(requests.calls.slice(before).map((c) => c.url)).toEqual(['/api/articles?offset=4&limit=2']);
  expect(historyWrites().at(-1)).toMatchObject({ op: 'push' });
});
