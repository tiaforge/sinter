import { expect, test } from 'vitest';
import { render, mockRequests } from '@tiaforge-ui/sinter/testing';
import page from './field-errors.html?raw';


test('shows the server\'s field errors on the fields', async () => {
  const requests = mockRequests({
    'POST /api/signup': { status: 422, body: { errors: { email: 'is already taken', username: ['is too short'] } } },
  });
  const { root, settle } = await render(page, { requests });
  const [email, username] = root.querySelectorAll('input');
  email!.value = 'ada@example.com';
  username!.value = 'a';
  root.querySelector('form')!.requestSubmit();
  await settle();

  expect(email!.getAttribute('aria-invalid')).toBe('true');
  expect(email!.nextElementSibling!.textContent).toBe('is already taken');
  expect(username!.getAttribute('aria-invalid')).toBe('true');
  expect(root.querySelector('#username-error')!.textContent).toBe('is too short');

  email!.dispatchEvent(new Event('input', { bubbles: true }));   // editing clears that field's error
  expect(email!.hasAttribute('aria-invalid')).toBe(false);
});

test('shows what no field takes in data-sn-errors', async () => {
  const requests = mockRequests({ 'POST /api/signup': { status: 503, body: { message: 'Sign-ups are paused.' } } });
  const { root, settle } = await render(page, { requests });
  for (const input of root.querySelectorAll('input')) input.value = 'ada@example.com';
  root.querySelector('form')!.requestSubmit();
  await settle();
  expect(root.querySelector('[data-sn-errors]')!.textContent).toBe('Sign-ups are paused.');
});
