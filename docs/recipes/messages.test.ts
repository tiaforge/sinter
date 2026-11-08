import { expect, test } from 'vitest';
import { memoryStorage, mockRequests, render } from '@tiaforge-ui/sinter/testing';
import page from './messages.html?raw';

// messages/en.json and messages/de.json (the base language first)
const messages = {
  en: { inbox_title: 'Inbox', inbox_count: '{count} unread', language: 'Language' },
  de: { inbox_title: 'Posteingang', inbox_count: '{count} ungelesen', language: 'Sprache' },
};

test('the stored language, with parameters; switching re-renders without a reload', async () => {
  const storage = memoryStorage();
  storage.setItem('locale', 'de');
  const requests = mockRequests({ 'GET /api/inbox': { unread: 3 } });
  const { root, settle, flush, navigations } = await render(page, { messages, storage, requests });
  await settle();
  expect(root.querySelector('h1')!.textContent).toBe('Posteingang');
  expect(root.querySelector('p')!.textContent).toBe('3 ungelesen');

  const select = root.querySelector('select')!;
  select.value = 'en';
  select.dispatchEvent(new Event('change', { bubbles: true }));
  await flush();
  await new Promise((r) => setTimeout(r, 0));
  await flush();
  expect(root.querySelector('h1')!.textContent).toBe('Inbox');
  expect(root.querySelector('p')!.textContent).toBe('3 unread');
  expect(document.documentElement.lang).toBe('en');
  expect(navigations).toEqual([]);
});
