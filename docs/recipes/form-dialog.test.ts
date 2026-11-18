import { expect, test } from 'vitest';
import { render, mockRequests } from '@tiaforge-ui/sinter/testing';
import page from './form-dialog.html?raw';


test('saves the draft and upserts the result', async () => {
  const requests = mockRequests({
    'GET /api/people': [],
    'POST /api/people': (call) => ({ id: 1, ...(call.body as object) }),
  });
  const { root, flush, settle } = await render(page, { requests });
  await settle();
  root.querySelector('button')!.click();               // New
  const dialog = root.querySelector('dialog')!;
  dialog.showModal();
  dialog.dispatchEvent(new Event('toggle'));
  await flush();

  const [name, email] = root.querySelectorAll('dialog input');
  (name as HTMLInputElement).value = 'Ada';
  name!.dispatchEvent(new Event('input', { bubbles: true }));
  (email as HTMLInputElement).value = 'ada@example.com';
  email!.dispatchEvent(new Event('input', { bubbles: true }));
  root.querySelector('form')!.requestSubmit();
  await settle();

  expect(requests.calls.at(-1)!.body).toEqual({ name: 'Ada', emails: [{ value: 'ada@example.com' }] });
  expect(root.querySelector('li span')!.textContent).toBe('Ada');
  expect(dialog.open).toBe(false);
});

test('a rejected save keeps the dialog open, with the message on its field', async () => {
  const requests = mockRequests({
    'GET /api/people': [],
    'POST /api/people': { status: 422, body: { errors: { name: 'is taken' } } },
  });
  const { root, flush, settle } = await render(page, { requests });
  await settle();
  root.querySelector('button')!.click();               // New
  const dialog = root.querySelector('dialog')!;
  dialog.showModal();
  dialog.dispatchEvent(new Event('toggle'));
  await flush();

  const name = root.querySelector('dialog input') as HTMLInputElement;
  name.value = 'Ada';
  name.dispatchEvent(new Event('input', { bubbles: true }));
  root.querySelector('form')!.requestSubmit();
  await settle();

  expect(dialog.open).toBe(true);
  expect(name.getAttribute('aria-invalid')).toBe('true');
  expect(root.querySelector('[data-sn-error="name"]')!.textContent).toBe('is taken');
  expect(root.querySelector('li')).toBeNull();
});
