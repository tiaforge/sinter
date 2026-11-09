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
  const seen: string[] = [];
  configure({
    onError: (e) => reported.push(e.message),
    // RFC 9457's `invalid-params`, as some APIs send them
    fieldErrors: (e, request) => {
      seen.push(`${request.method} ${request.url}`);
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
    expect(seen).toEqual(['POST /api/users']);
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

test('the form\'s markup reads its last failed send as $error: a summary with plain bindings, no toast', async () => {
  configure({ onError: (e) => reported.push(e.message) });
  let res: unknown = { status: 422, body: { errors: { 'email or password': ['is invalid'], email: 'is unknown' } } };
  const requests = mockRequests({ 'POST /api/login': () => res });
  const { root, settle } = await render(`
    <form data-sn-post="/api/login">
      <template data-sn-if="$error">
        <ul><template data-sn-for="e in Object.entries($error.body?.errors ?? {})"><li data-sn-text="e[0] + ' ' + e[1]"></li></template></ul>
        <p data-sn-text="$error.detail ?? $error.status"></p>
      </template>
      <input name="email"><button>Sign in</button>
    </form>`, { requests });
  root.querySelector('form')!.requestSubmit();
  await settle();
  expect([...root.querySelectorAll('li')].map((li) => li.textContent)).toEqual(['email or password is invalid', 'email is unknown']);
  // the field is still marked (fieldErrors): the two do not exclude each other
  expect(root.querySelector('[name=email]')!.getAttribute('aria-invalid')).toBe('true');
  // a key no field has would be a toast, but the markup shows $error: handled
  expect(reported).toEqual([]);

  // a 5xx: no field errors, the markup shows the detail; sending again empties $error, a success keeps it null
  res = { status: 503, body: { message: 'Down for maintenance.' } };
  root.querySelector('form')!.requestSubmit();
  await settle();
  expect(root.querySelector('li')).toBeNull();
  expect(root.querySelector('p')!.textContent).toBe('Down for maintenance.');
  expect(root.querySelector('[aria-invalid]')).toBeNull();
  res = { id: 1 };
  root.querySelector('form')!.requestSubmit();
  await settle();
  expect(root.querySelector('p')).toBeNull();
  expect(reported).toEqual([]);
});

test('$error inside a form with its own state, set by a button\'s action in a template', async () => {
  const requests = mockRequests({ 'POST /api/articles': { status: 422, body: { errors: { title: ["can't be blank"] } } } });
  const { root, settle } = await render(`
    <form data-sn-on-submit="$event.preventDefault()" data-sn-state="{ d: { title: '' } }">
      <output data-sn-text="$error ? $error.status + ' ' + d.title.length : 'ok'"></output>
      <template data-sn-if="true"><button type="button" data-sn-post="/api/articles" data-sn-body="{article: d}">Publish</button></template>
    </form>`, { requests });
  expect(root.querySelector('output')!.textContent).toBe('ok');
  root.querySelector('button')!.click();
  await settle();
  expect(root.querySelector('output')!.textContent).toBe('422 0');
});

test('$error outside a form, or in a catch, is the action\'s own', async () => {
  await expect(render(`<p data-sn-text="$error"></p>`)).rejects.toThrow(/SN201 .*`\$error` is not available here.*inside a `<form>`/s);
  const requests = mockRequests({ 'POST /api/x': { status: 500, body: null } });
  const { root, settle } = await render(`
    <div data-sn-state="{ s: 0 }"><button data-sn-post="/api/x" data-sn-catch="s = $error.status">x</button><output data-sn-text="s"></output></div>`, { requests });
  root.querySelector('button')!.click();
  await settle();
  expect(root.querySelector('output')!.textContent).toBe('500');
});
