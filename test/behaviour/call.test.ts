import { describe, expect, test } from 'vitest';
import { compile } from '../../src/compiler/index.js';
import { SinterError } from '../../src/index.js';
import type { CallContext } from '../../src/index.js';
import { render, mockRequests } from '../../src/testing/index.js';

/** a promise the test settles by hand */
function deferred<T>() {
  let resolve!: (v: T) => void, reject!: (e: unknown) => void;
  const promise = new Promise<T>((ok, no) => { resolve = ok; reject = no; });
  return { promise, resolve, reject };
}

describe('data-sn-call: actions that call a function', () => {
  test('arguments at trigger time, the lifecycle of an action, $result in then', async () => {
    const seen: unknown[][] = [];
    const run = deferred<string>();
    const actions = {
      greet: (name: string, n: number, ctx: CallContext) => { seen.push([name, n, ctx.el?.localName, ctx.signal instanceof AbortSignal]); return run.promise; },
    };
    const { root, flush, settle } = await render(`
      <div data-sn-state="{ name: 'Ada', out: '' }">
        <button data-sn-call="greet(name, 2)" data-sn-then="out = $result"></button>
        <p data-sn-text="out"></p>
      </div>`, { actions });
    const button = root.querySelector('button')!;
    button.click();
    await flush();
    expect(seen).toEqual([['Ada', 2, 'button', true]]);
    expect(button.getAttribute('aria-busy')).toBe('true');
    run.resolve('Hello Ada');
    await settle();
    expect(root.querySelector('p')!.textContent).toBe('Hello Ada');
    expect(button.hasAttribute('aria-busy')).toBe(false);
  });

  test('namespaces, and ctx.request through the request layer', async () => {
    const requests = mockRequests({ 'POST /api/archive': { ok: true } });
    const actions = {
      mail: { archive: async (id: number, ctx: CallContext) => ctx.request('/api/archive', { method: 'POST', body: { id } }) },
    };
    const { root, settle } = await render(`
      <div data-sn-state="{ r: null }">
        <button data-sn-call="mail.archive(7)" data-sn-then="r = $result.ok"></button><p data-sn-text="r"></p>
      </div>`, { actions, requests });
    root.querySelector('button')!.click();
    await settle();
    expect(requests.calls.map((c) => [c.method, c.path, c.body])).toEqual([['POST', '/api/archive', { id: 7 }]]);
    expect(root.querySelector('p')!.textContent).toBe('true');
  });

  test('errors: a thrown error has status null; a SinterError passes through', async () => {
    const requests = mockRequests({ 'GET /api/x': { status: 500, body: { e: 1 } } });
    const actions = {
      fails: async () => { throw new Error('Session key decryption failed'); },
      fetches: async (ctx: CallContext) => ctx.request('/api/x'),
    };
    const { root, settle } = await render(`
      <div data-sn-state="{ a: '', b: '' }">
        <button id="a" data-sn-call="fails()" data-sn-catch="a = $error.status + ':' + $error.message"></button>
        <button id="b" data-sn-call="fetches()" data-sn-catch="b = String($error.status)"></button>
        <p data-sn-text="a + '|' + b"></p>
      </div>`, { actions, requests });
    root.querySelector<HTMLElement>('#a')!.click();
    root.querySelector<HTMLElement>('#b')!.click();
    await settle();
    expect(root.querySelector('p')!.textContent).toBe('null:Session key decryption failed|500');
  });

  test('optimistic layers: shown at once, rolled back when the call throws, kept when then writes', async () => {
    const run = deferred<void>();
    const requests = mockRequests({ 'GET /api/items': [{ id: 1, n: 'a' }, { id: 2, n: 'b' }] });
    const actions = { drop: () => run.promise };
    const { root, flush, settle } = await render(`
      <sn-resource name="items" src="/api/items" key="id"></sn-resource>
      <ul><template data-sn-for="it in items">
        <li><span data-sn-text="it.n"></span><button data-sn-call="drop(it)" data-sn-optimistic="remove('items', it)" data-sn-then="remove('items', it)"></button></li>
      </template></ul>`, { actions, requests });
    await settle();
    const names = () => [...root.querySelectorAll('span')].map((s) => s.textContent).join(',');
    root.querySelector('button')!.click();
    await flush();
    expect(names()).toBe('b');
    run.reject(new Error('no'));
    await settle();
    expect(names()).toBe('a,b');
  });

  test('concurrency: queue by default, block on forms', async () => {
    let n = 0;
    const gates: Array<ReturnType<typeof deferred<void>>> = [];
    const actions = { work: () => { n++; const d = deferred<void>(); gates.push(d); return d.promise; } };
    const { root, flush, settle } = await render(`
      <div data-sn-state="{ v: '' }">
        <button data-sn-call="work()"></button>
        <form data-sn-call="work()"><button type="submit"></button></form>
      </div>`, { actions });
    const [button, submit] = root.querySelectorAll('button');
    button!.click(); button!.click();
    await flush();
    expect(n).toBe(1); // queued
    gates[0]!.resolve();
    await flush(); await flush();
    expect(n).toBe(2);
    gates[1]!.resolve();
    submit!.click(); submit!.click();
    await flush();
    expect(n).toBe(3); // blocked
    gates[2]!.resolve();
    await settle();
  });

  test('an unhandled failure takes the sn-error path; pagehide aborts ctx.signal', async () => {
    let signal: AbortSignal | null = null;
    const actions = {
      boom: async () => { throw new Error('x'); },
      wait: (ctx: CallContext) => { signal = ctx.signal; return new Promise(() => {}); },
    };
    const { root, settle, window } = await render(`
      <section data-sn-state="{ msg: '' }" data-sn-on-sn-error="msg = $event.detail.error.message; $event.preventDefault()">
        <button id="b" data-sn-call="boom()"></button><button id="w" data-sn-call="wait()"></button><p data-sn-text="msg"></p>
      </section>`, { actions });
    root.querySelector<HTMLElement>('#b')!.click();
    await settle();
    expect(root.querySelector('p')!.textContent).toBe('x');
    root.querySelector<HTMLElement>('#w')!.click();
    await Promise.resolve();
    expect(signal!.aborted).toBe(false);
    await window('pagehide');
    expect(signal!.aborted).toBe(true);
  });
});

describe('<sn-resource call>: resources fed by a function', () => {
  test('loads, reloads when its inputs change, aborts and drops a superseded load', async () => {
    const pending = new Map<string, ReturnType<typeof deferred<{ text: string }>>>();
    const signals = new Map<string, AbortSignal>();
    const actions = {
      pgp: {
        decrypt: (id: string, ctx: CallContext) => {
          signals.set(id, ctx.signal);
          const d = deferred<{ text: string }>();
          pending.set(id, d);
          return d.promise;
        },
      },
    };
    const { root, flush, settle } = await render(`
      <div data-sn-state="{ open: 'a' }">
        <sn-resource name="body" call="pgp.decrypt(open)" when="open"></sn-resource>
        <button data-sn-on-click="open = 'b'"></button>
        <p data-sn-text="($meta.body.loading ? 'loading ' : '') + (body?.text ?? '')"></p>
      </div>`, { actions });
    await flush();
    expect(root.querySelector('p')!.textContent).toBe('loading ');
    pending.get('a')!.resolve({ text: 'A' });
    await settle();
    expect(root.querySelector('p')!.textContent).toBe('A');
    root.querySelector('button')!.click();
    await flush();
    expect([...pending.keys()]).toEqual(['a', 'b']);
    expect(root.querySelector('p')!.textContent).toBe('loading A');
    pending.get('b')!.resolve({ text: 'B' });
    await settle();
    expect(root.querySelector('p')!.textContent).toBe('B');
  });

  test('a superseded call is aborted and its late result dropped', async () => {
    const pending = new Map<string, ReturnType<typeof deferred<{ text: string }>>>();
    const signals = new Map<string, AbortSignal>();
    const actions = {
      read: (id: string, ctx: CallContext) => {
        signals.set(id, ctx.signal);
        const d = deferred<{ text: string }>();
        pending.set(id, d);
        return d.promise;
      },
    };
    const { root, flush, settle } = await render(`
      <div data-sn-state="{ open: 'a' }">
        <sn-resource name="body" call="read(open)"></sn-resource>
        <button data-sn-on-click="open = 'b'"></button>
        <p data-sn-text="body?.text ?? ''"></p>
      </div>`, { actions });
    await flush();
    root.querySelector('button')!.click();
    await flush();
    expect(signals.get('a')!.aborted).toBe(true);
    pending.get('b')!.resolve({ text: 'B' });
    pending.get('a')!.resolve({ text: 'A (late)' });
    await settle();
    expect(root.querySelector('p')!.textContent).toBe('B');
  });

  test('errors and refresh()', async () => {
    let fail = true;
    const actions = { load: async () => { if (fail) throw new Error('locked'); return { text: 'ok' }; } };
    const { root, settle } = await render(`
      <section data-sn-on-sn-error="$event.preventDefault()">
        <sn-resource name="body" call="load()"></sn-resource>
        <button data-sn-on-click="refresh('body')"></button>
        <p data-sn-text="$meta.body.error ? $meta.body.error.status + ':' + $meta.body.error.message : body?.text"></p>
      </section>`, { actions });
    await settle();
    expect(root.querySelector('p')!.textContent).toBe('null:locked');
    fail = false;
    root.querySelector('button')!.click();
    await settle();
    expect(root.querySelector('p')!.textContent).toBe('ok');
  });
});

describe('call diagnostics', () => {
  const actions = { module: '/src/sinter.actions.js', names: ['archive'], namespaces: { pgp: { module: '/src/pgp.js', members: ['decrypt'] } } };
  const diags = (html: string) => compile(html, {
    file: '/p/page.html', root: '/p', dev: false, readFile: () => '', helpers: { module: null, names: [], namespaces: {} }, actions,
  }).diagnostics.map((d) => `${d.code} ${d.message}`);

  test('a valid call compiles; the page module imports only what it calls', () => {
    const out = compile('<div data-sn-state="{ m: 1 }"><button data-sn-call="pgp.decrypt(m)"></button></div>', {
      file: '/p/page.html', root: '/p', dev: false, readFile: () => '', helpers: { module: null, names: [], namespaces: {} }, actions,
    });
    expect(out.diagnostics).toEqual([]);
    expect(out.module).toContain(`import { decrypt as $a$pgp$decrypt } from "/src/pgp.js";`);
    expect(out.module).not.toContain('archive');
  });
  test('unknown actions, with a suggestion', () => {
    expect(diags('<button data-sn-call="pgp.decrpyt(1)"></button>')).toEqual(['SN310 `pgp.decrpyt` is not exported by the actions module. Did you mean `pgp.decrypt`?']);
    expect(diags('<button data-sn-call="archiv(1)"></button>')).toEqual(['SN310 `archiv` is not exported by the actions module. Did you mean `archive`?']);
  });
  test('the value is one call', () => {
    expect(diags('<button data-sn-call="archive"></button>')[0]).toMatch(/^SN401 `data-sn-call` is one call of an action/);
    expect(diags('<button data-sn-call="archive(1); archive(2)"></button>')[0]).toMatch(/^SN401 `data-sn-call` is one call of an action/);
  });
  test('one action per element; no data-sn-body on a call', () => {
    expect(diags('<button data-sn-post="/x" data-sn-call="archive(1)"></button>')).toContain('SN102 an element has one action: a method attribute or `data-sn-call`, not both');
    expect(diags('<button data-sn-call="archive(1)" data-sn-body="{a: 1}"></button>')).toContain('SN102 `data-sn-body` belongs to a method attribute; a call takes its arguments in `data-sn-call`');
  });
  test('actions do not run inside expressions', () => {
    expect(diags('<button data-sn-on-click="archive(1)"></button>')[0]).toMatch(/^SN203 `archive` is an action: actions run through `data-sn-call`/);
  });
  test('resources: src or call; call does not combine with paginate, each, cache', () => {
    expect(diags('<sn-resource name="b" src="/x" call="archive(1)"></sn-resource><p data-sn-text="b"></p>')).toContain('SN102 a resource loads from `src` or from `call`, not both');
    expect(diags('<sn-resource name="b"></sn-resource><p data-sn-text="b"></p>')).toContain('SN401 resource `b` needs a `src` (or a `call`)');
    expect(diags('<sn-resource name="b" call="archive(1)" key="id" paginate="keyset" page-size="5" cursor="{id}"></sn-resource><p data-sn-text="b"></p>'))
      .toContain('SN401 `paginate` does not combine with `call` in v0.2');
  });
});

test('SinterError keeps a null status', () => {
  expect(new SinterError(null, 1, 'x').status).toBeNull();
});
