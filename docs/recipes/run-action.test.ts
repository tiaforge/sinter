import { expect, test } from 'vitest';
import { checkPage } from '@tiaforge-ui/sinter/check';
import { render, mockRequests } from '@tiaforge-ui/sinter/testing';
import page from './run-action.html?raw';

const MESSAGES = { messages: [{ id: 1, subject: 'Hello', is_read: false }, { id: 2, subject: 'Lunch?', is_read: true }] };
const key = (el: Element, k: string) => el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));

test('opening an unread mail marks it read once its body has loaded; a read one sends nothing', async () => {
  const requests = mockRequests({
    'GET /api/messages': MESSAGES,
    'GET /api/messages/1/body': { text: 'Hi there' },
    'GET /api/messages/2/body': { text: 'At noon?' },
    'PATCH /api/messages/1': null,
  });
  const { root, settle } = await render(page, { requests });
  await settle();
  const rows = () => [...root.querySelectorAll('li')];
  expect(rows().map((li) => li.className)).toEqual(['unread', '']);

  rows()[0]!.click();
  await settle();
  expect(root.querySelector('article')!.textContent).toBe('Hi there');
  expect(requests.calls.at(-1)).toMatchObject({ method: 'PATCH', path: '/api/messages/1', body: { is_read: true } });
  expect(rows()[0]!.className).toBe('');

  rows()[1]!.click();
  await settle();
  expect(requests.calls.filter((c) => c.method === 'PATCH')).toHaveLength(1);
});

test('a failed mark-read rolls back and shows the error', async () => {
  const requests = mockRequests({
    'GET /api/messages': MESSAGES,
    'GET /api/messages/1/body': { text: 'Hi there' },
    'PATCH /api/messages/1': { status: 503, body: { message: 'Mail server unavailable' } },
  });
  const { root, settle } = await render(page, { requests });
  await settle();
  root.querySelector('li')!.click();
  await settle();
  expect(root.querySelector('li')!.className).toBe('unread');
  expect(root.querySelector('[role=alert]')!.textContent).toBe('Mail server unavailable');
});

test('E archives the open mail through the button; with no mail open the button is disabled and E does nothing', async () => {
  const requests = mockRequests({
    'GET /api/messages': MESSAGES,
    'GET /api/messages/2/body': { text: 'At noon?' },
    'POST /api/messages/2/archive': null,
  });
  const { root, settle } = await render(page, { requests });
  await settle();
  key(root, 'e');
  await settle();
  expect(requests.calls.map((c) => c.method)).toEqual(['GET']);

  root.querySelectorAll('li')[1]!.click();
  await settle();
  key(root, 'e');
  await settle();
  expect(requests.calls.at(-1)).toMatchObject({ method: 'POST', path: '/api/messages/2/archive' });
  expect([...root.querySelectorAll('li')].map((li) => li.textContent)).toEqual(['Hello']);
  expect(root.querySelector('button')!.disabled).toBe(true);
});

test('sinter check: run() names an element with an action', () => {
  expect(checkPage(page).filter((d) => d.severity === 'error')).toEqual([]);
  const [d] = checkPage(page.replace("run('mark-read')", "run('mark-raed')")).filter((x) => x.severity === 'error');
  expect([d!.code, d!.message]).toEqual(['SN311', 'no element `id="mark-raed"` on this page. Did you mean `mark-read`?']);
});
