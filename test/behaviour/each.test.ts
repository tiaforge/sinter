import { describe, expect, test } from 'vitest';
import { compile } from '../../src/compiler/index.js';
import { render, mockRequests, mockStream, type RecordedCall } from '../../src/testing/index.js';

// Caley's mail sidebar: mailboxes are listed per account
const MAILBOXES: Record<string, string[]> = { a: ['INBOX', 'Sent'], b: ['INBOX'], c: ['Archive'] };

function server(accounts: string[], boxes = MAILBOXES) {
  return mockRequests({
    'GET /api/accounts': () => accounts.map((id) => ({ account_id: id })),
    'GET /api/mailboxes': (call: RecordedCall) => {
      const id = new URL(call.url, 'http://x').searchParams.get('account_id')!;
      return { mailboxes: (boxes[id] ?? []).map((name) => ({ account_id: id, name })) };
    },
  });
}

const PAGE = `
  <sn-resource name="accounts" src="/api/accounts" key="account_id"></sn-resource>
  <sn-resource name="mailboxes" each="a in accounts" src="/api/mailboxes?account_id={a.account_id}"
    items="mailboxes" key="account_id,name" order="name"></sn-resource>
  <sn-sync src="/s">
    <sn-event name="account_added" resource="accounts" op="upsert"></sn-event>
    <sn-event name="account_removed" resource="accounts" op="remove"></sn-event>
    <sn-event name="mailboxes_changed" resource="mailboxes" op="refetch"></sn-event>
    <sn-event name="mailbox_renamed" resource="mailboxes" op="patch" set="{label}"></sn-event>
    <sn-event name="mailbox_created" resource="mailboxes" op="upsert"></sn-event>
  </sn-sync>
  <b data-sn-text="[$meta.mailboxes.loading, !!$meta.mailboxes.loadedAt].join()"></b>
  <button data-sn-on-click="refresh('mailboxes')"></button>
  <ul><template data-sn-for="m in mailboxes"><li data-sn-text="m.account_id + ':' + (m.label ?? m.name)"></li></template></ul>`;

async function setup(accounts = ['a', 'b'], boxes = MAILBOXES) {
  const requests = server(accounts, boxes);
  const stream = mockStream();
  const out = await render(PAGE, { requests, streams: { '/s': stream } });
  const list = () => [...out.root.querySelectorAll('li')].map((l) => l.textContent).join(' ');
  const mailboxCalls = () => requests.calls.filter((c) => c.path === '/api/mailboxes').map((c) => c.url);
  return { ...out, requests, stream, list, mailboxCalls };
}

describe('each: one resource fed by one request per item', () => {
  test('loads every source and merges them into one ordered collection', async () => {
    const { root, settle, list, mailboxCalls } = await setup();
    await settle();
    expect(mailboxCalls()).toEqual(['/api/mailboxes?account_id=a', '/api/mailboxes?account_id=b']);
    expect(list()).toBe('a:INBOX b:INBOX a:Sent');
    expect(root.querySelector('b')!.textContent).toBe('false,true');
  });

  test('an empty list is loaded once the list resource is: no requests, loadedAt set', async () => {
    const { root, settle, mailboxCalls } = await setup([]);
    expect(root.querySelector('b')!.textContent).toBe('false,false');
    await settle();
    expect(mailboxCalls()).toEqual([]);
    expect(root.querySelector('b')!.textContent).toBe('false,true');
  });

  test('a new list item adds a source; a removed one drops its items', async () => {
    const { settle, stream, list, mailboxCalls } = await setup();
    await settle();
    stream.emit('account_added', { account_id: 'c' });
    await settle();
    expect(mailboxCalls().at(-1)).toBe('/api/mailboxes?account_id=c');
    expect(mailboxCalls()).toHaveLength(3); // a and b are not reloaded
    expect(list()).toBe('c:Archive a:INBOX b:INBOX a:Sent');
    stream.emit('account_removed', { account_id: 'a' });
    await settle();
    expect(list()).toBe('c:Archive b:INBOX');
    expect(mailboxCalls()).toHaveLength(3);
  });

  test('a refetch event whose payload names a source reloads only that source', async () => {
    const boxes = { ...MAILBOXES };
    const { settle, stream, list, mailboxCalls } = await setup(['a', 'b'], boxes);
    await settle();
    boxes.b = ['INBOX', 'Work'];
    stream.emit('mailboxes_changed', { account_id: 'b' });
    await settle();
    expect(mailboxCalls().slice(2)).toEqual(['/api/mailboxes?account_id=b']);
    expect(list()).toBe('a:INBOX b:INBOX a:Sent b:Work');
    // no usable payload: every source
    stream.emit('mailboxes_changed', {});
    await settle();
    expect(mailboxCalls().slice(3)).toEqual(['/api/mailboxes?account_id=a', '/api/mailboxes?account_id=b']);
  });

  test('refresh() reloads every source; refetches in one task share one round', async () => {
    const { root, settle, stream, mailboxCalls } = await setup();
    await settle();
    root.querySelector('button')!.click();
    stream.emit('mailboxes_changed', { account_id: 'a' });
    await settle();
    expect(mailboxCalls().slice(2)).toEqual(['/api/mailboxes?account_id=a', '/api/mailboxes?account_id=b']);
  });

  test('reloading one source keeps event changes to the others, and replaces its own', async () => {
    const boxes = { ...MAILBOXES };
    const { settle, stream, list } = await setup(['a', 'b'], boxes);
    await settle();
    stream.emit('mailbox_renamed', { account_id: 'b', name: 'INBOX', label: 'Posteingang' });
    // created by an event, not by a response: it belongs to `a` because src resolves to a's URL with it
    stream.emit('mailbox_created', { account_id: 'a', name: 'Temp' });
    await settle();
    const sorted = () => list().split(' ').sort().join(' ');
    expect(sorted()).toBe('a:INBOX a:Sent a:Temp b:Posteingang');
    stream.emit('mailboxes_changed', { account_id: 'a' }); // the server no longer has Temp
    await settle();
    expect(sorted()).toBe('a:INBOX a:Sent b:Posteingang');
  });

  test('when turns every source off and drops the items; turning it on loads them again', async () => {
    const page = `<div data-sn-state="{ on: true }">
      <sn-resource name="accounts" src="/api/accounts" key="account_id"></sn-resource>
      <sn-resource name="mailboxes" each="a in accounts" when="on" src="/api/mailboxes?account_id={a.account_id}"
        items="mailboxes" key="account_id,name" order="name"></sn-resource>
      <input type="checkbox" checked data-sn-model="on">
      <ul><template data-sn-for="m in mailboxes"><li data-sn-text="m.account_id + ':' + m.name"></li></template></ul></div>`;
    const requests = server(['a', 'b']);
    const { root, settle } = await render(page, { requests });
    const list = () => [...root.querySelectorAll('li')].map((l) => l.textContent).join(' ');
    await settle();
    expect(list()).toBe('a:INBOX b:INBOX a:Sent');
    const box = root.querySelector('input')!;
    box.checked = false;
    box.dispatchEvent(new Event('change', { bubbles: true }));
    await settle();
    expect(list()).toBe('');
    box.checked = true;
    box.dispatchEvent(new Event('change', { bubbles: true }));
    await settle();
    expect(list()).toBe('a:INBOX b:INBOX a:Sent');
  });
});

describe('each diagnostics', () => {
  const diags = (attrs: string) => compile(`<sn-resource name="accounts" src="/api/accounts" key="id"></sn-resource>
    <sn-resource name="m" ${attrs}></sn-resource><p data-sn-text="m.length + accounts.length"></p>`, {
    file: '/p/page.html', root: '/p', dev: false, readFile: () => '', helpers: { module: null, names: [], namespaces: {} },
  }).diagnostics.map((d) => `${d.code} ${d.message}`);

  test('the loop variable is in scope for src only', () => {
    expect(diags('each="a in accounts" src="/api/m?id={a.id}" key="id"')).toEqual([]);
    expect(diags('src="/api/m?id={a.id}" key="id"')[0]).toMatch(/^SN201 /);
  });
  test('syntax, key and the attributes it does not combine with', () => {
    expect(diags('each="accounts" src="/api/m" key="id"')).toEqual(['SN401 `each` takes `item in list`, e.g. `a in accounts`']);
    expect(diags('each="a in accounts" src="/api/m?id={a.id}"')).toEqual(['SN401 an `each` resource is a collection: it needs `key`, with a field that tells the sources apart']);
    expect(diags('each="a in accounts" src="/api/m?id={a.id}" key="id" total="n"')).toEqual(['SN401 `total` does not combine with `each`: the items come from several requests']);
    expect(diags('each="a in accounts" src="/api/m?id={a.id}" key="id" cache')).toEqual(['SN401 `cache` does not combine with `each`: the items come from several requests']);
  });
});
