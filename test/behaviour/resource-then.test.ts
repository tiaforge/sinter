// `then` on <sn-resource>: a handler run after each successful load.
import { describe, expect, test } from 'vitest';
import type { CallContext } from '../../src/index.js';
import { memoryStorage, mockRequests, mockStream, render, type RecordedCall } from '../../src/testing/index.js';

const LIST = (then: string, attrs = '') => `
  <main data-sn-state="{ n: 0, last: '', q: 'a' }">
    <sn-resource name="contacts" src="/api/contacts?q={q}" items="contacts" key="id" order="name" ${attrs} then="${then}"></sn-resource>
    <sn-sync src="/api/events">
      <sn-event name="changed" resource="contacts" op="refetch"></sn-event>
      <sn-event name="updated" resource="contacts" op="upsert" item="contact"></sn-event>
    </sn-sync>
    <button id="refresh" data-sn-on-click="refresh('contacts')"></button>
    <button id="q" data-sn-on-click="q = 'b'"></button>
    <button id="edit" data-sn-patch="/api/contacts/1" data-sn-optimistic="patch('contacts', contacts[0], { name: 'Zed' })"></button>
    <p data-sn-text="n + ' ' + last + ' ' + contacts.length"></p>
  </main>`;

const contacts = (call: RecordedCall) => {
  const q = new URL(call.url, 'http://x').searchParams.get('q');
  return { contacts: q === 'a' ? [{ id: 1, name: 'Ada' }, { id: 2, name: 'Bob' }] : [{ id: 3, name: 'Cy' }] };
};

describe('<sn-resource then>', () => {
  test('runs after each load, with the store, $meta and $result current; state writes re-render', async () => {
    const seen: unknown[] = [];
    let app: any;
    const requests = mockRequests({ 'GET /api/contacts': contacts, 'PATCH /api/contacts/1': { id: 1, name: 'Zed' } });
    const stream = mockStream();
    const r = await render(LIST("n++; last = $result.map((c) => c.name).join(); seen($result.length, contacts.length, $meta.contacts.loading, !!$meta.contacts.loadedAt)"), {
      requests, streams: { '/api/events': stream },
      helpers: { seen: (...a: unknown[]) => seen.push([...a, app.resource('contacts').all().length]) },
    });
    app = r.app;
    const text = () => r.root.querySelector('p')!.textContent;
    const click = async (id: string) => { r.root.querySelector<HTMLElement>(`#${id}`)!.click(); await r.settle(); };
    await r.settle();
    expect(text()).toBe('1 Ada,Bob 2');
    expect(seen).toEqual([[2, 2, false, true, 2]]);

    // refresh(), an SSE refetch and a `src` change each load again
    await click('refresh');
    expect(text()).toBe('2 Ada,Bob 2');
    stream.emit('changed', {});
    await r.settle();
    expect(text()).toBe('3 Ada,Bob 2');
    await click('q');
    expect(text()).toBe('4 Cy 1');

    // an upsert from an event and an optimistic change are not loads
    stream.emit('updated', { contact: { id: 9, name: 'Dee' } });
    await click('edit');
    expect(text()).toBe('4 Cy 2');
  });

  test('a failed load does not run it; the next successful one does', async () => {
    let fail = true;
    const requests = mockRequests({ 'GET /api/contacts': () => (fail ? { status: 500 } : { contacts: [{ id: 1, name: 'Ada' }] }) });
    const r = await render(LIST('n++') + '<i data-sn-text="$meta.contacts.error?.status"></i>', { requests, streams: { '/api/events': mockStream() } });
    await r.settle().catch(() => {});
    expect(r.root.querySelector('p')!.textContent).toBe('0  0');
    expect(r.root.querySelector('i')!.textContent).toBe('500');
    fail = false;
    r.root.querySelector<HTMLElement>('#refresh')!.click();
    await r.settle();
    expect(r.root.querySelector('p')!.textContent).toBe('1  1');
  });

  test('a superseded load does not run it; only the response that is stored does', async () => {
    const seen: string[] = [];
    const requests = mockRequests({ 'GET /api/contacts': contacts });
    const r = await render(LIST('seen($result[0].name)'), { requests, streams: { '/api/events': mockStream() }, helpers: { seen: (n: string) => seen.push(n) } });
    // `q` changes before the first response: that load is aborted
    r.root.querySelector<HTMLElement>('#q')!.click();
    await r.settle();
    expect(seen).toEqual(['Cy']);
  });

  test('not for the cached data shown at once; after the revalidation', async () => {
    const session = memoryStorage();
    const html = LIST('n++', 'cache');
    const first = await render(html, { session, requests: mockRequests({ 'GET /api/contacts': contacts }), streams: { '/api/events': mockStream() } });
    await first.settle();
    await first.window('pagehide');

    const r = await render(html, { session, requests: mockRequests({ 'GET /api/contacts': { contacts: [{ id: 5, name: 'Eve' }] } }), streams: { '/api/events': mockStream() } });
    expect(r.root.querySelector('p')!.textContent).toBe('0  2');
    await r.settle();
    expect(r.root.querySelector('p')!.textContent).toBe('1  1');
  });

  test('embedded data counts as the first load', async () => {
    const r = await render(`<html><head><script type="application/json" data-sn-data="people">[{"id":1,"name":"Ada"}]</script></head><body>
      <main data-sn-state="{ names: '' }">
        <sn-resource name="people" src="/api/people" key="id" then="names = $result.map((p) => p.name).join()"></sn-resource>
        <p data-sn-text="names + ' ' + people.length"></p>
      </main></body></html>`);
    await r.flush();
    expect(r.root.querySelector('p')!.textContent).toBe('Ada 1');
  });

  test('Caley: a pending share opens compose once the page has loaded', async () => {
    const actions = {
      mail: {
        pendingCompose: async (_ctx: CallContext) => ({ subject: 'Invoice', files: ['a.pdf'] }),
      },
    };
    const { root, settle } = await render(`
      <main data-sn-state="{ compose: null }">
        <sn-resource name="pending" call="mail.pendingCompose()"
          then="$result && (compose = { subject: $result.subject, files: $result.files }, showModal('mail-compose'))"></sn-resource>
        <dialog id="mail-compose"><h2 data-sn-text="compose?.subject"></h2><p data-sn-text="compose?.files.join()"></p></dialog>
        <i data-sn-text="pending?.subject"></i>
      </main>`, { actions });
    await settle();
    const dialog = root.querySelector('dialog')!;
    expect(dialog.open).toBe(true);
    expect(dialog.querySelector('h2')!.textContent).toBe('Invoice');
    expect(dialog.querySelector('p')!.textContent).toBe('a.pdf');
  });

  test('a call resource with nothing pending: `$result` is null and the guard skips', async () => {
    const { root, settle } = await render(`
      <main data-sn-state="{ ran: 0 }">
        <sn-resource name="pending" call="pending()" then="ran++; $result && showModal('d')"></sn-resource>
        <dialog id="d"></dialog><p data-sn-text="ran + ' ' + !!pending"></p>
      </main>`, { actions: { pending: async () => null } });
    await settle();
    expect(root.querySelector('p')!.textContent).toBe('1 false');
    expect(root.querySelector('dialog')!.open).toBe(false);
  });

  test('`each`: once per source that answers, with that source\'s items', async () => {
    const seen: string[] = [];
    const requests = mockRequests({
      'GET /api/accounts': [{ id: 'a' }, { id: 'b' }],
      'GET /api/boxes': (call: RecordedCall) => {
        const id = new URL(call.url, 'http://x').searchParams.get('account')!;
        return { boxes: [{ account: id, name: 'INBOX' }] };
      },
    });
    const stream = mockStream();
    const r = await render(`
      <sn-resource name="accounts" src="/api/accounts" key="id"></sn-resource>
      <sn-resource name="boxes" each="a in accounts" src="/api/boxes?account={a.id}" items="boxes" key="account,name"
        then="seen($result.map((b) => b.account).join())"></sn-resource>
      <sn-sync src="/s"><sn-event name="boxes_changed" resource="boxes" op="refetch"></sn-event></sn-sync>
      <ul><template data-sn-for="b in boxes"><li data-sn-text="b.account"></li></template></ul>`,
    { requests, streams: { '/s': stream }, helpers: { seen: (s: string) => seen.push(s) } });
    await r.settle();
    expect(seen.sort()).toEqual(['a', 'b']);
    // a refetch for one source runs it for that source
    stream.emit('boxes_changed', { id: 'b' });
    await r.settle();
    expect(seen.slice(2)).toEqual(['b']);
  });

  test('pagination: each page that loads, `$result` being that page', async () => {
    const all = Array.from({ length: 5 }, (_, i) => ({ id: i + 1 }));
    const requests = mockRequests({
      'GET /api/m': (call: RecordedCall) => {
        const q = new URL(call.url, 'http://x').searchParams;
        const page = Number(q.get('page') ?? 1), size = Number(q.get('limit'));
        return { items: all.slice((page - 1) * size, page * size), total: all.length };
      },
    });
    const { root, settle } = await render(`
      <main data-sn-state="{ got: [] }">
        <sn-resource name="m" src="/api/m" items="items" total="total" key="id" paginate="offset" page-size="2"
          then="got = [...got, $result.map((x) => x.id).join('+')]"></sn-resource>
        <button data-sn-on-click="page('m', 'next')"></button>
        <p data-sn-text="got.join(' ') + ' / ' + m.length"></p>
      </main>`, { requests });
    await settle();
    root.querySelector('button')!.click();
    await settle();
    expect(root.querySelector('p')!.textContent).toBe('1+2 3+4 / 2');
  });
});
