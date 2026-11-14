// Same id, same control: when a branch swap removes the focused element, the element with its `id` in
// the new branch takes focus. Nothing else moves focus.
import { expect, test } from 'vitest';
import { mockRequests, render } from '../../src/testing/index.js';

const TOGGLE = `
  <sn-resource name="a" src="/api/a"></sn-resource>
  <template data-sn-if="a">
    <template data-sn-if="a.on"><button id="t" data-sn-delete="/api/a/on" data-sn-optimistic="patch(a, { on: false })">On</button></template>
    <template data-sn-else><button id="t" data-sn-post="/api/a/on" data-sn-optimistic="patch(a, { on: true })">Off</button></template>
  </template>
  <input id="elsewhere">`;
const api = () => mockRequests({ 'GET /api/a': { on: false }, 'POST /api/a/on': { on: true }, 'DELETE /api/a/on': { on: false } });

test('a toggle: the other branch\'s button with the same id keeps focus, both ways', async () => {
  const r = await render(TOGGLE, { requests: api() });
  await r.settle();
  const doc = r.root.ownerDocument, t = () => doc.getElementById('t') as HTMLButtonElement;
  t().focus();
  const first = t();
  first.click();
  await r.settle();
  expect(t().textContent).toBe('On');
  expect(t()).not.toBe(first);
  expect(doc.activeElement).toBe(t());
  t().click();
  await r.settle();
  expect(t().textContent).toBe('Off');
  expect(doc.activeElement).toBe(t());
});

test('focus somewhere else is left alone; a swap without the focused element moves nothing', async () => {
  const r = await render(TOGGLE, { requests: api() });
  await r.settle();
  const doc = r.root.ownerDocument, other = doc.getElementById('elsewhere') as HTMLInputElement;
  other.focus();
  (doc.getElementById('t') as HTMLButtonElement).click();
  await r.settle();
  expect(doc.getElementById('t')!.textContent).toBe('On');
  expect(doc.activeElement).toBe(other);
});

test('no twin, or no id: focus is not moved', async () => {
  const r = await render(`
    <div data-sn-state="{ open: false }">
      <template data-sn-if="!open"><button id="edit" data-sn-on-click="open = true">Edit</button></template>
      <template data-sn-else><form id="form"><input id="field"><button type="button" data-sn-on-click="open = false">Done</button></form></template>
    </div>`);
  const doc = r.root.ownerDocument;
  (doc.getElementById('edit') as HTMLButtonElement).focus();
  (doc.getElementById('edit') as HTMLButtonElement).click();
  await r.flush();
  expect(doc.getElementById('form')).not.toBeNull();
  // the form has no element with id "edit": focus is where the browser put it, not on the field
  expect(doc.activeElement).not.toBe(doc.getElementById('field'));
  const done = doc.querySelector('form button') as HTMLButtonElement;
  done.focus();
  done.click();
  await r.flush();
  // "Done" had no id: nothing to restore
  expect(doc.activeElement).not.toBe(doc.getElementById('edit'));
});

test('a bound id in a list row: the row\'s own twin, not another row\'s', async () => {
  const r = await render(`
    <sn-resource name="items" src="/api/items" key="id"></sn-resource>
    <ul><template data-sn-for="x in items"><li>
      <template data-sn-if="x.fav"><button data-sn-attr="{ id: 'fav-' + x.id }" data-sn-on-click="patch(x, { fav: false })">Unfav</button></template>
      <template data-sn-else><button data-sn-attr="{ id: 'fav-' + x.id }" data-sn-on-click="patch(x, { fav: true })">Fav</button></template>
    </li></template></ul>`, { requests: mockRequests({ 'GET /api/items': [{ id: 1, fav: false }, { id: 2, fav: false }] }) });
  await r.settle();
  const doc = r.root.ownerDocument;
  (doc.getElementById('fav-2') as HTMLButtonElement).focus();
  (doc.getElementById('fav-2') as HTMLButtonElement).click();
  await r.flush();
  expect(doc.getElementById('fav-2')!.textContent).toBe('Unfav');
  expect(doc.activeElement).toBe(doc.getElementById('fav-2'));
});
