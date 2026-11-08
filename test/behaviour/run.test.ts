// run('id'): a handler starts the action of the element with that id, with the element's lifecycle.
import { afterEach, describe, expect, test, vi } from 'vitest';
import { compile } from '../../src/compiler/index.js';
import { configure } from '../../src/index.js';
import type { CallContext } from '../../src/index.js';
import { render, mockRequests } from '../../src/testing/index.js';

const key = (el: Element, k: string, init: KeyboardEventInit = {}) =>
  el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...init }));

afterEach(() => { configure({ confirm: (q) => globalThis.confirm(q) }); vi.restoreAllMocks(); });

describe('run(): starting an action from a handler', () => {
  test('<sn-resource then> runs a call: the optimistic change shows at once, is kept on success', async () => {
    const marked: number[] = [];
    let fail = false;
    const actions = {
      mail: {
        body: async (m: { id: number }) => `body of ${m.id}`,
        markRead: async (m: { id: number }, ctx: CallContext) => { marked.push(m.id); expect(ctx.el?.id).toBe('mark-read'); if (fail) throw new Error('offline'); },
      },
    };
    const requests = mockRequests({ 'GET /api/messages': [{ id: 1, is_read: false }, { id: 2, is_read: false }] });
    const { root, flush, settle } = await render(`
      <main data-sn-state="{ open: null, error: '' }">
        <sn-resource name="messages" src="/api/messages" key="id"></sn-resource>
        <span hidden id="mark-read" data-sn-call="mail.markRead(open)"
              data-sn-optimistic="patch('messages', open, {is_read: true})" data-sn-catch="error = $error.message"></span>
        <sn-resource name="body" call="mail.body(open)" when="open"
                     then="$result && !open.is_read && run('mark-read')"></sn-resource>
        <template data-sn-for="m in messages"><li data-sn-class="{unread: !m.is_read}" data-sn-on-click="open = m"></li></template>
        <p data-sn-text="error"></p>
      </main>`, { actions, requests });
    await settle();
    const rows = () => [...root.querySelectorAll('li')].map((li) => li.className);
    expect(rows()).toEqual(['unread', 'unread']);

    (root.querySelector('li') as HTMLElement).click();
    await settle();
    expect(marked).toEqual([1]);
    expect(rows()).toEqual(['', 'unread']);

    fail = true;
    (root.querySelectorAll('li')[1] as HTMLElement).click();
    await settle();
    expect(marked).toEqual([1, 2]);
    expect(rows()).toEqual(['', 'unread']);               // rolled back
    expect(root.querySelector('p')!.textContent).toBe('offline');
    void flush;
  });

  test('a key filter runs a request action; its aria-busy, then and own click handler', async () => {
    const requests = mockRequests({ 'POST /api/archive': { ok: true } });
    const { root, flush, settle } = await render(`
      <body data-sn-state="{ done: 0, clicked: 0 }" data-sn-on-keydown-e="run('archive')">
        <button id="archive" data-sn-post="/api/archive" data-sn-body="{n: done}" data-sn-then="done = done + 1"
                data-sn-on-click="clicked = clicked + 1">Archive</button>
        <p data-sn-text="done + '/' + clicked"></p>
      </body>`, { requests });
    key(root, 'e');
    await flush();
    const button = root.querySelector('button')!;
    expect(button.getAttribute('aria-busy')).toBe('true');
    await settle();
    expect(button.hasAttribute('aria-busy')).toBe(false);
    expect(requests.calls.map((c) => [c.method, c.path, c.body])).toEqual([['POST', '/api/archive', { n: 0 }]]);
    // run() is not a click: the element's own data-sn-on-click does not run
    expect(root.querySelector('p')!.textContent).toBe('1/0');
  });

  test('then chains: A runs B after it succeeds; B sees state A wrote just before', async () => {
    const requests = mockRequests({ 'POST /api/a': { id: 7 }, 'POST /api/b': null });
    const { root, settle } = await render(`
      <div data-sn-state="{ id: 0 }">
        <button id="a" data-sn-post="/api/a" data-sn-then="id = $result.id; run('b')"></button>
        <span id="b" data-sn-post="/api/b?id={id}"></span>
      </div>`, { requests });
    root.querySelector('button')!.click();
    await settle();
    expect(requests.calls.map((c) => c.url.replace(/^https?:\/\/[^/]+/, ''))).toEqual(['/api/a', '/api/b?id=7']);
  });

  test('$event is null in a non-form target, the action runs in its own scope', async () => {
    const requests = mockRequests({ 'POST /api/x': null });
    const { root, settle } = await render(`
      <div data-sn-state="{ q: 'outer' }">
        <button data-sn-on-click="run('x')"></button>
        <section data-sn-state="{ q: 'inner' }">
          <span id="x" data-sn-post="/api/x" data-sn-body="{none: $event === null, q: q}"></span>
        </section>
      </div>`, { requests });
    root.querySelector('button')!.click();
    await settle();
    expect(requests.calls[0]!.body).toEqual({ none: true, q: 'inner' });
  });

  test('a form is submitted: validation runs, data-sn-on-submit runs, $event is the submit event', async () => {
    const requests = mockRequests({ 'POST /api/save': null });
    const { root, settle } = await render(`
      <div data-sn-state="{ submits: 0 }" data-sn-on-keydown-mod-enter="run('f')">
        <form id="f" data-sn-post="/api/save" data-sn-body="{type: $event.type}"
              data-sn-on-submit="submits = submits + 1">
          <input name="t" required>
        </form>
        <p data-sn-text="submits"></p>
      </div>`, { requests });
    key(root.querySelector('div')!, 'Enter', { ctrlKey: true });
    await settle();
    expect(requests.calls).toEqual([]);                    // invalid: not sent
    root.querySelector('input')!.value = 'x';
    key(root.querySelector('div')!, 'Enter', { ctrlKey: true });
    await settle();
    // (submitter is null in browsers; happy-dom passes the form)
    expect(requests.calls.map((c) => c.body)).toEqual([{ type: 'submit' }]);
    expect(root.querySelector('p')!.textContent).toBe('1');
  });

  test('disabled or inert: nothing; hidden or in a closed dialog: runs', async () => {
    const requests = mockRequests({ 'POST /api/hidden': null, 'POST /api/dialog': null, 'POST /api/disabled': null, 'POST /api/inert': null, 'POST /api/fieldset': null });
    const { root, settle } = await render(`
      <div data-sn-state="{ on: true }">
        <button id="go" data-sn-on-click="run('disabled'); run('fieldset'); run('inert'); run('hidden'); run('dialog')"></button>
        <button id="disabled" disabled data-sn-post="/api/disabled"></button>
        <fieldset disabled><button id="fieldset" data-sn-post="/api/fieldset"></button></fieldset>
        <div inert><span id="inert" data-sn-post="/api/inert"></span></div>
        <span hidden id="hidden" data-sn-post="/api/hidden"></span>
        <dialog><span id="dialog" data-sn-post="/api/dialog"></span></dialog>
      </div>`, { requests });
    (root.querySelector('#go') as HTMLElement).click();
    await settle();
    // happy-dom does not match `:disabled` inside a disabled <fieldset>; browsers do
    const fieldset = root.querySelector('#fieldset')!.matches(':disabled') ? [] : ['/api/fieldset'];
    expect(requests.calls.map((c) => c.path)).toEqual([...fieldset, '/api/hidden', '/api/dialog']);
  });

  test('a target in a data-sn-if branch that does not render: nothing, with a dev warning', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const requests = mockRequests({ 'POST /api/x': null });
    const { root, flush, settle } = await render(`
      <div data-sn-state="{ show: false }">
        <button data-sn-on-click="run('x')"></button>
        <template data-sn-if="show"><span id="x" data-sn-post="/api/x"></span></template>
        <input type="checkbox" data-sn-model="show">
      </div>`, { requests });
    root.querySelector('button')!.click();
    await settle();
    expect(requests.calls).toEqual([]);
    expect(warn.mock.calls.flat().join(' ')).toMatch(/run\('x'\)`: no element with that id and an action is on the page/);
    const box = root.querySelector('input')!;
    box.checked = true;
    box.dispatchEvent(new Event('change', { bubbles: true }));
    await flush();
    root.querySelector('button')!.click();
    await settle();
    expect(requests.calls.map((c) => c.path)).toEqual(['/api/x']);
  });

  test("the target's concurrency: queue sends every run in order, block ignores runs while one is pending", async () => {
    const requests = mockRequests({ 'POST /api/q': null, 'POST /api/b': null });
    const { root, settle } = await render(`
      <div data-sn-state="{ n: 0 }">
        <button data-sn-on-click="n = n + 1; run('q'); run('b')"></button>
        <span id="q" data-sn-post="/api/q" data-sn-body="{n: n}"></span>
        <span id="b" data-sn-post="/api/b" data-sn-concurrency="block"></span>
      </div>`, { requests });
    const button = root.querySelector('button')!;
    button.click();
    button.click();
    await settle();
    expect(requests.calls.filter((c) => c.path === '/api/q').map((c) => c.body)).toEqual([{ n: 1 }, { n: 2 }]);
    expect(requests.calls.filter((c) => c.path === '/api/b')).toHaveLength(1);
  });

  test('confirm is asked (no: nothing), debounce applies', async () => {
    let answer = false;
    const asked: string[] = [];
    configure({ confirm: (q) => { asked.push(q); return answer; } });
    const requests = mockRequests({ 'DELETE /api/x': null, 'POST /api/d': null });
    const { root, settle, advance } = await render(`
      <div>
        <button data-sn-on-click="run('x')"></button>
        <span id="x" data-sn-delete="/api/x" data-sn-confirm="'Delete?'"></span>
        <i data-sn-on-click="run('d')"></i>
        <span id="d" data-sn-post="/api/d" data-sn-debounce="300"></span>
      </div>`, { requests });
    root.querySelector('button')!.click();
    await settle();
    expect(asked).toEqual(['Delete?']);
    expect(requests.calls).toEqual([]);
    answer = true;
    root.querySelector('button')!.click();
    await settle();
    expect(requests.calls.map((c) => c.method)).toEqual(['DELETE']);

    const i = root.querySelector('i')!;
    i.click();
    i.click();
    await advance(300);
    await settle();
    expect(requests.calls.filter((c) => c.path === '/api/d')).toHaveLength(1);
  });

  test('works from <sn-event then> and returns nothing', async () => {
    const { mockStream } = await import('../../src/testing/index.js');
    const stream = mockStream();
    const requests = mockRequests({ 'POST /api/seen': null });
    const { root, settle } = await render(`
      <div data-sn-state="{ r: 'unset' }">
        <sn-sync src="/api/events"><sn-event name="ping" then="r = String(run('seen'))"></sn-event></sn-sync>
        <span id="seen" data-sn-post="/api/seen"></span><p data-sn-text="r"></p>
      </div>`, { requests, streams: { '/api/events': stream } });
    stream.emit('ping', {});
    await settle();
    expect(requests.calls.map((c) => c.path)).toEqual(['/api/seen']);
    expect(root.querySelector('p')!.textContent).toBe('undefined');
  });
});

describe('run() diagnostics', () => {
  const actions = { module: '/src/a.js', names: ['archive'], namespaces: { mail: { module: '/src/mail.js', members: ['markRead'] } } };
  const diags = (html: string, checkCycles = false) => compile(html, {
    file: '/p/page.html', root: '/p', dev: false, readFile: () => '', helpers: { module: null, names: [], namespaces: {} }, actions, checkCycles,
  }).diagnostics.map((d) => `${d.code} ${d.message}`);

  test('SN311: a literal id of one action element outside rows', () => {
    const page = (call: string, rest = '') => diags(`<div data-sn-state="{ x: 'a' }"><button data-sn-on-click="${call}"></button>
      <span id="mark-read" data-sn-post="/x"></span><p id="plain"></p>${rest}</div>`);
    expect(page("run('mark-read')")).toEqual([]);
    expect(page('run(x)')).toEqual(["SN311 `run()` takes the action element's `id` as a string literal"]);
    expect(page("run('mark-raed')")).toEqual(['SN311 no element `id="mark-raed"` on this page. Did you mean `mark-read`?']);
    expect(page("run('plain')")).toEqual(['SN311 `#plain` has no action (`data-sn-get`, `-post`, `-put`, `-patch`, `-delete` or `data-sn-call`); `run()` starts actions, not handlers']);
    expect(page("run('row')", `<template data-sn-for="m in [1]" data-sn-key="m"><button id="row" data-sn-post="/x"></button></template>`))
      .toEqual(['SN311 `#row` is inside a `data-sn-for` row, so every row has it; put the action outside the list and pass the row through state']);
    expect(page("run('mark-read')", '<i id="mark-read"></i>')).toEqual(['SN311 2 elements have `id="mark-read"`; `run()` needs one']);
    // a data-sn-if branch is fine; so are element-less handlers and data-sn-call targets
    expect(page("run('maybe')", `<template data-sn-if="x"><span id="maybe" data-sn-call="mail.markRead(x)"></span></template>
      <sn-sync src="/e"><sn-event name="n" then="run('maybe')"></sn-event></sn-sync>`)).toEqual([]);
  });

  test('a store function: not in values or optimistic changes; a resource cannot be called run', () => {
    expect(diags(`<span id="a" data-sn-post="/x"></span><p data-sn-text="run('a')"></p>`)).toEqual(['SN203 value expressions cannot call `run()`; move it to a handler']);
    expect(diags(`<span id="a" data-sn-post="/x"></span><button data-sn-post="/y" data-sn-optimistic="run('a')"></button>`))
      .toEqual([expect.stringMatching(/^SN204 `data-sn-optimistic` may only call `patch`, `upsert`, `remove`/)]);
    expect(diags('<sn-resource name="run" src="/x"></sn-resource>')).toContain('SN209 `run` is a store function (`run()`); a resource cannot take its name');
  });

  test('SN203 for an action in a handler points to run()', () => {
    const [d] = compile('<div data-sn-state="{ open: null }"><button data-sn-on-click="mail.markRead(open)"></button></div>', {
      file: '/p/page.html', root: '/p', dev: false, readFile: () => '', helpers: { module: null, names: [], namespaces: {} }, actions,
    }).diagnostics;
    expect(d!.message).toBe("`mail` is an action, and a handler cannot call it: put the call on an element with an `id` and start it with `run('id')`");
    expect(d!.hint).toBe(`<span hidden id="mark-read" data-sn-call="mail.markRead(…)"></span>, then run('mark-read') in the handler; the element's busy state, concurrency, optimistic layer and then/catch apply`);
  });

  test('SN509 (opt-in): then/catch handlers that start each other again, with every step', () => {
    const html = `<div data-sn-state="{ n: 0 }">
<sn-resource name="body" src="/b" then="run('mark')"></sn-resource><p data-sn-text="body"></p>
<span id="mark" data-sn-post="/m" data-sn-then="refresh('body')"></span>
<button id="a" data-sn-post="/a" data-sn-then="run('b')"></button>
<button id="b" data-sn-post="/b" data-sn-catch="n = n + 1; run('a')" data-sn-on-click="run('b')"></button>
<button id="self" data-sn-post="/s" data-sn-catch="run('self')"></button>
<button id="loop" data-sn-post="/l" data-sn-on-click="run('loop')"></button>
</div>`;
    expect(diags(html)).toEqual([]);
    expect(diags(html, true)).toEqual([
      'SN509 `run()` cycle: `<sn-resource name="body">` `then` (page.html:2) runs `#mark`, then `#mark` `data-sn-then` (page.html:3) refreshes `body`, which starts the first step again',
      'SN509 `run()` cycle: `#a` `data-sn-then` (page.html:4) runs `#b`, then `#b` `data-sn-catch` (page.html:5) runs `#a`, which starts the first step again',
      'SN509 `run()` cycle: `#self` `data-sn-catch` (page.html:6) runs `#self`, which starts the first step again',
    ]);
    // refresh alone is not a run() cycle
    expect(diags('<sn-resource name="r" src="/r" then="refresh(\'r\')"></sn-resource>', true)).toEqual([]);
  });
});

describe('run() in sinter check', () => {
  test('$event in a non-form target is RunEvent<…>: unguarded reads are errors; a form keeps its SubmitEvent', async () => {
    const { checkPage } = await import('../../src/check/index.js');
    const page = (body: string, form = '{a: $event.submitter}') => `<div data-sn-state="{ n: 0 }" data-sn-on-keydown-x="run('x'); run('f')">
  <button id="x" data-sn-post="/api/x" data-sn-body="${body}"></button>
  <button id="y" data-sn-post="/api/y" data-sn-body="{s: $event.shiftKey}"></button>
  <form id="f" data-sn-post="/api/f" data-sn-body="${form}"></form>
</div>`;
    expect(checkPage(page('{s: $event && $event.shiftKey}'))).toEqual([]);
    const d = checkPage(page('{s: $event.shiftKey}'));
    expect(d.map((x) => [x.code, x.line, x.message])).toEqual([['SN208', 2, expect.stringMatching(/Property 'shiftKey' does not exist on type 'RunEvent<PointerEvent>'/)]]);
  });

  test('SN509 is opt-in through checkCycles', async () => {
    const { checkPage } = await import('../../src/check/index.js');
    const html = `<button id="a" data-sn-post="/a" data-sn-catch="run('a')"></button>`;
    expect(checkPage(html).map((x) => x.code)).toEqual([]);
    expect(checkPage(html, { checkCycles: true }).map((x) => [x.code, x.message])).toEqual([['SN509', '`run()` cycle: `#a` `data-sn-catch` (index.html:1) runs `#a`, which starts the first step again']]);
  });
});
