// Server validation errors on the fields (fields.ts): a 4xx with `{errors: {field: message}}` marks
// the named controls aria-invalid and shows the messages next to them.
import { afterEach, expect, test } from 'vitest';
import { configure } from '../../src/index.js';
import { render, mockRequests } from '../../src/testing/index.js';

const reported: string[] = [];
afterEach(() => { reported.length = 0; configure({ onError: null }); });

const form = (extra = '') => `
  <form data-sn-post="/api/users" ${extra}>
    <label>Email <input name="email" value="ada@example.com"></label>
    <label>Name <input name="name" value="Ada" aria-errormessage="name-error"></label>
    <p id="name-error" hidden></p>
    <button>Save</button>
  </form>`;

test('a 422 marks each named field aria-invalid and shows its message next to it', async () => {
  configure({ onError: (e) => reported.push(e.message) });
  const requests = mockRequests({ 'POST /api/users': { status: 422, body: { errors: { email: 'is already taken', name: ['is too short', 'has a digit'] } } } });
  const { root, settle } = await render(form(), { requests });
  root.querySelector('form')!.requestSubmit();
  await settle();
  await Promise.resolve();

  const email = root.querySelector<HTMLInputElement>('[name=email]')!, name = root.querySelector<HTMLInputElement>('[name=name]')!;
  expect(email.getAttribute('aria-invalid')).toBe('true');
  const msg = email.nextElementSibling!;
  expect(msg.localName).toBe('small');
  expect(msg.textContent).toBe('is already taken');
  expect(email.getAttribute('aria-errormessage')).toBe(msg.id);
  expect(email.getAttribute('aria-describedby')).toBe(msg.id);
  // the app's own message element, named by aria-errormessage, is filled and shown
  const own = root.querySelector('#name-error')!;
  expect(name.getAttribute('aria-invalid')).toBe('true');
  expect(own.textContent).toBe('is too short; has a digit');
  expect(own.hasAttribute('hidden')).toBe(false);
  // every error found its field: handled, so no onError
  expect(reported).toEqual([]);
  expect(document.activeElement).toBe(email);

  // editing a field clears its error
  email.value = 'ada@example.org';
  email.dispatchEvent(new Event('input', { bubbles: true }));
  expect(email.hasAttribute('aria-invalid')).toBe(false);
  expect(email.hasAttribute('aria-errormessage')).toBe(false);
  expect(email.hasAttribute('aria-describedby')).toBe(false);
  expect(root.querySelector('small')).toBeNull();
  expect(name.getAttribute('aria-invalid')).toBe('true');
});

test('sending the form again clears the errors; a success leaves none', async () => {
  let fail = true;
  const requests = mockRequests({ 'POST /api/users': () => (fail ? { status: 422, body: { errors: { name: 'is required' } } } : { id: 1 }) });
  const { root, settle } = await render(form(), { requests });
  root.querySelector('form')!.requestSubmit();
  await settle();
  const own = root.querySelector('#name-error')!;
  expect(own.textContent).toBe('is required');
  fail = false;
  root.querySelector('form')!.requestSubmit();
  await settle();
  expect(root.querySelector('[aria-invalid]')).toBeNull();
  expect(own.textContent).toBe('');
  expect(own.hasAttribute('hidden')).toBe(true);
});

test('an error with no field of that name still takes the unhandled path; other errors are untouched', async () => {
  configure({ onError: (e) => reported.push(e.message) });
  let res: unknown = { status: 422, body: { errors: { email: 'is invalid', plan: 'is full' } } };
  const requests = mockRequests({ 'POST /api/users': () => res });
  const { root, settle } = await render(form(), { requests });
  root.querySelector('form')!.requestSubmit();
  await settle();
  expect(root.querySelector('[name=email]')!.getAttribute('aria-invalid')).toBe('true');
  expect(reported).toHaveLength(1);

  res = { status: 500, body: { errors: { email: 'is invalid' } } };
  root.querySelector('form')!.requestSubmit();
  await settle();
  expect(root.querySelector('[aria-invalid]')).toBeNull();
  expect(reported).toHaveLength(2);
});

test('a form with data-sn-catch handles its errors itself', async () => {
  const requests = mockRequests({ 'POST /api/users': { status: 422, body: { errors: { email: 'is invalid' } } } });
  const { root, settle } = await render(`<div data-sn-state="{ err: null }">${form('data-sn-catch="err = $error.status"')}<output data-sn-text="err"></output></div>`, { requests });
  root.querySelector('form')!.requestSubmit();
  await settle();
  expect(root.querySelector('[aria-invalid]')).toBeNull();
  expect(root.querySelector('output')!.textContent).toBe('422');
});

test('a button\'s action inside a form shows the errors on that form\'s fields, from inside a template too', async () => {
  const requests = mockRequests({ 'POST /api/articles': { status: 400, body: { errors: { title: ["can't be blank"] } } } });
  const { root, settle } = await render(`
    <form data-sn-on-submit="$event.preventDefault()" data-sn-state="{ d: { title: '' }, editing: false }">
      <input name="title" data-sn-model="d.title">
      <template data-sn-if="!editing"><button type="button" data-sn-post="/api/articles" data-sn-body="{article: d}">Publish</button></template>
    </form>`, { requests });
  root.querySelector('button')!.click();
  await settle();
  const title = root.querySelector('[name=title]')!;
  expect(title.getAttribute('aria-invalid')).toBe('true');
  expect(title.nextElementSibling!.textContent).toBe("can't be blank");
});

test('configure({ fieldErrors }) reads another error format; null leaves the error to the unhandled path', async () => {
  configure({
    onError: (e) => reported.push(e.message),
    // RFC 9457's `invalid-params`, as some APIs send them
    fieldErrors: (e) => {
      const p = (e.body as any)?.['invalid-params'];
      return Array.isArray(p) ? Object.fromEntries(p.map((x: any) => [x.name, x.reason])) : null;
    },
  });
  let res: unknown = { status: 400, body: { type: 'about:blank', title: 'Your request is not valid.', 'invalid-params': [{ name: 'email', reason: 'must be an email address' }] } };
  const requests = mockRequests({ 'POST /api/users': () => res });
  try {
    const { root, settle } = await render(form(), { requests });
    root.querySelector('form')!.requestSubmit();
    await settle();
    expect(root.querySelector('[name=email]')!.nextElementSibling!.textContent).toBe('must be an email address');
    expect(reported).toEqual([]);

    res = { status: 422, body: { errors: { email: 'is invalid' } } };    // not the configured format
    root.querySelector('form')!.requestSubmit();
    await settle();
    expect(root.querySelector('[aria-invalid]')).toBeNull();
    expect(reported).toHaveLength(1);
  } finally {
    configure({ fieldErrors: null });
  }
});
