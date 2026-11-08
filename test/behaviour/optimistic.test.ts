// Optimistic layers settle: a success commits the change into the base, a failure rolls it back.
import { describe, expect, test } from 'vitest';
import { mockRequests, mockStream, render } from '../../src/testing/index.js';

/** an action function whose calls the test settles by hand, in any order */
function controlled() {
  const calls: Array<{ args: unknown[]; ok(v?: unknown): void; fail(): void }> = [];
  const fn = (...args: unknown[]) => new Promise((ok, no) => {
    calls.push({ args: args.slice(0, -1), ok: (v) => ok(v ?? null), fail: () => no(new Error('refused')) });
  });
  return { fn, calls };
}

const ITEM = { id: 1, subject: 'hi', flagged: false };

async function page(attrs = '', extra = '', items: object[] = [ITEM]) {
  const flag = controlled();
  const stream = mockStream();
  const requests = mockRequests({ 'GET /api/m': () => ({ m: items, total: 10 }) });
  const r = await render(`
    <sn-resource name="m" src="/api/m" items="m" total="total" key="id"></sn-resource>
    <sn-sync src="/s"><sn-event name="msg" resource="m" op="upsert"></sn-event><sn-event name="gone" resource="m" op="remove"></sn-event></sn-sync>
    <template data-sn-for="x in m">
      <div>
        <span data-sn-text="[x.subject, x.flagged ? 'flag' : '-'].join(' ')"></span>
        <button id="on" data-sn-call="flag(x.id, true)" data-sn-optimistic="patch('m', x, {flagged: true})" ${attrs}>on</button>
        <button id="off" data-sn-call="flag(x.id, false)" data-sn-optimistic="patch('m', x, {flagged: false})">off</button>
        <button id="toggle" data-sn-call="flag(x.id, !x.flagged)" data-sn-optimistic="patch('m', x, {flagged: !x.flagged})" ${attrs}>t</button>
        <button id="del" data-sn-call="flag(x.id, null)" data-sn-optimistic="remove('m', x)">del</button>
      </div>
    </template>
    <p data-sn-text="$meta.m.pending + ' ' + $meta.m.total + ' ' + m.length"></p>${extra}`,
  { requests, streams: { '/s': stream }, actions: { flag: flag.fn } });
  await r.settle();
  const text = () => r.root.querySelector('span')?.textContent ?? '';
  const meta = () => r.root.querySelector('p')!.textContent;
  const click = async (id: string) => { r.root.querySelector<HTMLElement>(`#${id}`)!.click(); await r.flush(); };
  /** settles a call and lets its handlers and the flush run */
  const settle = async (i: number, ok = true) => { ok ? flag.calls[i]!.ok() : flag.calls[i]!.fail(); await r.settle().catch(() => {}); };
  return { ...r, stream, requests, calls: flag.calls, text, meta, click, settleCall: settle };
}

describe('a successful request keeps its optimistic change', () => {
  test('success commits the layer; failure rolls it back', async () => {
    const p = await page('data-sn-catch="0"');
    await p.click('on');
    expect([p.text(), p.meta()]).toEqual(['hi flag', '1 10 1']);
    await p.settleCall(0);
    // no flip back: the change is in the base now, and nothing is pending
    expect([p.text(), p.meta()]).toEqual(['hi flag', '0 10 1']);
    expect(p.app.resource('m').base().items).toEqual([{ ...ITEM, flagged: true }]);

    await p.click('off');
    expect(p.text()).toBe('hi -');
    await p.settleCall(1, false);
    expect([p.text(), p.meta()]).toEqual(['hi flag', '0 10 1']);
  });

  test('`then` writes win over the committed change', async () => {
    const p = await page(`data-sn-then="patch('m', $result, {subject: 'server', flagged: false})"`);
    await p.click('on');
    p.calls[0]!.ok({ id: 1 });
    await p.settle();
    expect(p.text()).toBe('server -');
  });

  test('a committed remove keeps the total down', async () => {
    const p = await page();
    await p.click('del');
    expect(p.meta()).toBe('1 9 0');
    await p.settleCall(0);
    expect(p.meta()).toBe('0 9 0');
  });

  test('a server event during the request: both changes stay; a later event wins', async () => {
    const p = await page();
    await p.click('on');
    p.stream.emit('msg', { ...ITEM, subject: 'edited' });
    await p.flush();
    expect(p.text()).toBe('edited flag');
    await p.settleCall(0);
    expect(p.text()).toBe('edited flag');
    p.stream.emit('msg', { ...ITEM, subject: 'edited' });
    await p.flush();
    expect(p.text()).toBe('edited -');
  });

  test('a load that answers after the success replays the change on its (older) response', async () => {
    const p = await page();
    await p.click('on');
    p.app.resource('m').refetch();
    await p.flush();
    expect(p.requests.pending).toBe(1);
    // the call succeeds while the refetch is in flight; the refetch answers with the old item
    p.calls[0]!.ok();
    await p.flush();
    await p.settle();
    expect(p.text()).toBe('hi flag');
    // a refetch that starts after the success is newer: it wins
    p.app.resource('m').refetch();
    await p.settle();
    expect(p.text()).toBe('hi -');
  });
});

describe('overlapping layers on one item, settling out of order', () => {
  test('the newer succeeds first: it waits for the older, so the newest change stays on top', async () => {
    const p = await page();
    await p.click('on');
    await p.click('off');
    expect([p.text(), p.meta()]).toEqual(['hi -', '2 10 1']);
    await p.settleCall(1);
    expect([p.text(), p.meta()]).toEqual(['hi -', '1 10 1']);
    await p.settleCall(0);
    expect([p.text(), p.meta()]).toEqual(['hi -', '0 10 1']);
    expect((p.app.resource('m').base().items as any[])[0].flagged).toBe(false);
  });

  test('the newer succeeds, the older fails: the newer change stays', async () => {
    const p = await page();
    await p.click('on');
    await p.click('off');
    await p.settleCall(1);
    await p.settleCall(0, false);
    expect([p.text(), p.meta()]).toEqual(['hi -', '0 10 1']);
  });

  test('the older succeeds, the newer fails: the older change stays', async () => {
    const p = await page();
    await p.click('on');
    await p.click('off');
    await p.settleCall(0);
    expect(p.text()).toBe('hi -');
    await p.settleCall(1, false);
    expect([p.text(), p.meta()]).toEqual(['hi flag', '0 10 1']);
  });

  test('a server event wins over a succeeded change still waiting for an older one', async () => {
    const p = await page();
    await p.click('on');
    await p.click('off');
    await p.settleCall(1);
    // the server says flagged; the `on` request is still pending
    p.stream.emit('msg', { ...ITEM, flagged: true, subject: 'srv' });
    await p.flush();
    expect(p.text()).toBe('srv flag');
    await p.settleCall(0, false);
    expect(p.text()).toBe('srv flag');
  });
});

describe('concurrency', () => {
  test('queue: each queued request commits or rolls back its own layer', async () => {
    const p = await page();
    await p.click('toggle');   // on
    await p.click('toggle');   // off, queued
    expect([p.text(), p.calls.length]).toEqual(['hi -', 1]);
    await p.settleCall(0);
    expect(p.calls.length).toBe(2);
    await p.settleCall(1, false);
    expect([p.text(), p.meta()]).toEqual(['hi flag', '0 10 1']);
  });

  test('latest: a replaced waiting action is rolled back, the last one commits', async () => {
    const p = await page('data-sn-concurrency="latest"');
    await p.click('toggle');   // on, sent
    await p.click('toggle');   // off, waits
    await p.click('toggle');   // on, replaces the waiting one
    expect(p.meta()).toBe('2 10 1');
    await p.settleCall(0);
    await p.settleCall(1);
    expect(p.calls.map((c) => c.args)).toEqual([[1, true], [1, true]]);
    expect([p.text(), p.meta()]).toEqual(['hi flag', '0 10 1']);
  });

  test('block: a blocked trigger adds no layer', async () => {
    const p = await page('data-sn-concurrency="block"');
    await p.click('toggle');
    await p.click('toggle');
    expect([p.text(), p.meta(), p.calls.length]).toEqual(['hi flag', '1 10 1', 1]);
    await p.settleCall(0);
    expect([p.text(), p.meta()]).toEqual(['hi flag', '0 10 1']);
  });
});

test('islands: app.optimistic() keeps the change when `run` resolves', async () => {
  const requests = mockRequests({ 'GET /api/m': [{ id: 1 }, { id: 2 }], 'DELETE /api/m': null });
  const { root, flush, settle, app } = await render(`
    <sn-resource name="m" src="/api/m" key="id"></sn-resource>
    <p data-sn-text="m.length + ' ' + $meta.m.pending"></p>`, { requests });
  await settle();
  const done = app.optimistic(() => app.resource('m').remove('1'), () => app.request('/api/m', { method: 'DELETE' }));
  await flush();
  expect(root.querySelector('p')!.textContent).toBe('1 1');
  await settle();
  await done;
  await flush();
  expect(root.querySelector('p')!.textContent).toBe('1 0');
});
