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
  expect(root.querySelector('.active')!.textContent).toBe('3');
  await back();
  await settle();
  expect(titles(root)).toEqual(['A3', 'A4']);
});
