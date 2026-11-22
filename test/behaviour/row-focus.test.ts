// A row that goes while the focus is in it (a deleted item, an optimistic `remove()`, a server's event) does not leave
// the focus on <body>: it goes to the same control in the next row, else the previous one, else the list.
import { expect, test } from 'vitest';
import { mockRequests, render } from '../../src/testing/index.js';

const PAGE = `
  <sn-resource name="contacts" src="/api/contacts" key="id"></sn-resource>
  <ul id="list"><template data-sn-for="c in contacts"><li>
    <a data-sn-href="/c/{c.id}" data-sn-text="c.name"></a>
    <button class="del" data-sn-delete="/api/contacts/{c.id}" data-sn-optimistic="remove(c)">Delete</button>
  </li></template></ul>
  <input id="q">`;

const people = (...ids: number[]) => ids.map((id) => ({ id, name: 'P' + id }));
async function page(ids: number[]) {
  const routes: Record<string, any> = { 'GET /api/contacts': people(...ids) };
  for (const id of ids) routes[`DELETE /api/contacts/${id}`] = null;
  const r = await render(PAGE, { requests: mockRequests(routes) });
  await r.settle();
  const doc = r.root.ownerDocument;
  const del = (id: number) => [...r.root.querySelectorAll<HTMLButtonElement>('.del')].find((b) => b.closest('li')!.textContent!.includes('P' + id))!;
  const focused = () => doc.activeElement as HTMLElement;
  return { r, doc, del, focused };
}

test('deleting the focused row moves the focus to the same button in the next row', async () => {
  const { r, del, focused } = await page([1, 2, 3]);
  del(2).focus();
  del(2).click();
  await r.flush();
  expect(r.root.querySelectorAll('li')).toHaveLength(2);
  expect(focused()).toBe(del(3));
  await r.settle();
  expect(focused()).toBe(del(3));
});

test('the last row: the previous row; the only row: the list, made focusable', async () => {
  const { r, doc, del, focused } = await page([1, 2]);
  del(2).focus();
  del(2).click();
  await r.flush();
  expect(focused()).toBe(del(1));
  del(1).click();
  await r.flush();
  const list = doc.getElementById('list')!;
  expect(focused()).toBe(list);
  expect(list.getAttribute('tabindex')).toBe('-1');
});

// the list from state, as a server's event would replace it
const STATE = `
  <section data-sn-state="{ list: [{ id: 1 }, { id: 2 }, { id: 3 }] }">
    <ul><template data-sn-for="c in list" data-sn-key="c.id"><li>
      <a data-sn-href="/c/{c.id}" data-sn-text="c.id"></a> <button>Edit</button>
    </li></template></ul>
    <input id="q"><button data-sn-on-click="list = []">Clear</button>
  </section>`;

test('a row another change removes: its link\'s focus goes to the next row\'s link; focus elsewhere stays', async () => {
  const r = await render(STATE);
  const doc = r.root.ownerDocument, st = r.state(r.root.querySelector('section')!);
  const links = () => [...r.root.querySelectorAll('a')];
  links()[0]!.focus();
  st.update((s) => { s.list = [{ id: 2 }, { id: 3 }]; });
  await r.flush();
  expect(doc.activeElement).toBe(links()[0]);
  expect(links()[0]!.textContent).toBe('2');
  // a row that is not the focused one goes: the focus stays
  st.update((s) => { s.list = [{ id: 2 }]; });
  await r.flush();
  expect(doc.activeElement).toBe(links()[0]);
  const q = doc.getElementById('q') as HTMLInputElement;
  q.focus();
  st.update((s) => { s.list = []; });
  await r.flush();
  expect(doc.activeElement).toBe(q);
});
