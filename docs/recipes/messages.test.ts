import { expect, test } from 'vitest';
import { mockRequests, render } from '@tiaforge-ui/sinter/testing';
import page from './messages.html?raw';

// messages/en.json and messages/de.json (the base language first)
const messages = {
  en: { inbox_title: 'Inbox', inbox_count: '{count} unread', language: 'Language' },
  de: { inbox_title: 'Posteingang', inbox_count: '{count} ungelesen', language: 'Sprache' },
};

test('the page in its language, with parameters from data', async () => {
  const requests = mockRequests({ 'GET /api/inbox': { unread: 3 } });
  // the German page (`localePrefix` builds one per language; without it, the base language's)
  const { root, settle } = await render(page, { messages, requests, locale: 'de' });
  await settle();
  expect(root.querySelector('h1')!.textContent).toBe('Posteingang');
  expect([...root.querySelectorAll('p')].map((p) => p.textContent)).toEqual(['3 ungelesen', 'Sprache: de']);
});

test('without a language, the base language\'s page', async () => {
  const requests = mockRequests({ 'GET /api/inbox': { unread: 1 } });
  const { root, settle } = await render(page, { messages, requests });
  await settle();
  expect(root.querySelector('h1')!.textContent).toBe('Inbox');
  expect(root.querySelector('p')!.textContent).toBe('1 unread');
});
