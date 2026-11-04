import { afterEach, expect, test } from 'vitest';
import { configure } from '../../src/index.js';
import { render, mockRequests } from '../../src/testing/index.js';

afterEach(() => configure({ request: [], onError: null, sessionProbe: null, locale: null }));

const input = (el: HTMLInputElement, value: string, type = 'input') => {
  el.value = value;
  el.dispatchEvent(new Event(type, { bubbles: true }));
};

test('text, show, attr, class and style bindings follow state', async () => {
  const { root, flush } = await render(`
    <div data-sn-state="{ name: 'Ada', on: false, w: 10 }">
      <p data-sn-text="name" data-sn-class="{active: on}" data-sn-style="{width: w + 'px', '--c': on ? 'red' : null}"></p>
      <a data-sn-attr="{href: '/u/' + name, title: on && 'yes'}" data-sn-show="on">x</a>
      <button data-sn-on-click="on = !on; name = name + '!'; w++">toggle</button>
    </div>`);
  const p = root.querySelector('p')!;
  const a = root.querySelector('a')!;
  expect(p.textContent).toBe('Ada');
  expect(p.classList.contains('active')).toBe(false);
  expect(p.style.getPropertyValue('width')).toBe('10px');
  expect(a.hidden).toBe(true);
  expect(a.getAttribute('href')).toBe('/u/Ada');
  expect(a.hasAttribute('title')).toBe(false);

  root.querySelector('button')!.click();
  await flush();
  expect(p.textContent).toBe('Ada!');
  expect(p.classList.contains('active')).toBe(true);
  expect(p.style.getPropertyValue('width')).toBe('11px');
  expect(p.style.getPropertyValue('--c')).toBe('red');
  expect(a.hidden).toBe(false);
  expect(a.getAttribute('title')).toBe('yes');
});

test('text-like models update on input, others on change', async () => {
  const { root, flush } = await render(`
    <div data-sn-state="{ q: 'a', n: 1, ok: true, tags: ['x'], pick: 'b', many: ['1'] }">
      <input id="q" data-sn-model="q">
      <input id="n" type="number" data-sn-model="n">
      <input id="ok" type="checkbox" data-sn-model="ok">
      <input id="tx" type="checkbox" value="x" data-sn-model="tags">
      <input id="ty" type="checkbox" value="y" data-sn-model="tags">
      <input id="ra" type="radio" name="r" value="a" data-sn-model="pick">
      <input id="rb" type="radio" name="r" value="b" data-sn-model="pick">
      <select id="m" multiple data-sn-model="many"><option>1</option><option>2</option></select>
      <output data-sn-text="JSON.stringify({q, n, ok, tags, pick, many})"></output>
    </div>`);
  const $ = <T extends Element>(s: string) => root.querySelector(s) as unknown as T;
  const out = () => JSON.parse($<HTMLElement>('output').textContent!);
  expect($<HTMLInputElement>('#q').value).toBe('a');
  expect($<HTMLInputElement>('#ok').checked).toBe(true);
  expect($<HTMLInputElement>('#tx').checked).toBe(true);
  expect($<HTMLInputElement>('#ty').checked).toBe(false);
  expect($<HTMLInputElement>('#rb').checked).toBe(true);

  input($('#q'), 'abc');
  input($('#n'), '', 'change');
  const ok = $<HTMLInputElement>('#ok'); ok.checked = false; ok.dispatchEvent(new Event('change', { bubbles: true }));
  const ty = $<HTMLInputElement>('#ty'); ty.checked = true; ty.dispatchEvent(new Event('change', { bubbles: true }));
  const ra = $<HTMLInputElement>('#ra'); ra.checked = true; ra.dispatchEvent(new Event('change', { bubbles: true }));
  const m = $<HTMLSelectElement>('#m'); m.options[0]!.selected = false; m.options[1]!.selected = true; m.dispatchEvent(new Event('change', { bubbles: true }));
  await flush();
  expect(out()).toEqual({ q: 'abc', n: null, ok: false, tags: ['x', 'y'], pick: 'a', many: ['2'] });
});

test('keyed lists keep nodes, reorder and remove rows', async () => {
  const { root, flush, app } = await render(`
    <ul data-sn-state="{ items: [{id: 1, t: 'a'}, {id: 2, t: 'b'}, {id: 3, t: 'c'}] }">
      <template data-sn-for="(it, i) in items"><li data-sn-text="i + ':' + it.t"></li></template>
      <button data-sn-on-click="items.reverse()">rev</button>
      <button id="del" data-sn-on-click="items.splice(0, 1)">del</button>
      <button id="edit" data-sn-on-click="items.forEach(x => x.t = x.t.toUpperCase())">up</button>
    </ul>`);
  const lis = () => [...root.querySelectorAll('li')];
  const before = lis();
  expect(before.map((l) => l.textContent)).toEqual(['0:a', '1:b', '2:c']);
  root.querySelector('button')!.click();
  await flush();
  expect(lis().map((l) => l.textContent)).toEqual(['0:c', '1:b', '2:a']);
  expect(lis()[0]).toBe(before[2]);
  root.querySelector<HTMLElement>('#del')!.click();
  await flush();
  expect(lis().map((l) => l.textContent)).toEqual(['0:b', '1:a']);
  root.querySelector<HTMLElement>('#edit')!.click();
  await flush();
  expect(lis().map((l) => l.textContent)).toEqual(['0:B', '1:A']);
  // the list stays in place before the buttons
  expect(root.querySelector('ul')!.lastElementChild!.id).toBe('edit');
  expect(app).toBeDefined();
});

test('if/else switch branches and nested lists render inside them', async () => {
  const { root, flush } = await render(`
    <div data-sn-state="{ show: false, xs: ['a', 'b'] }">
      <template data-sn-if="show"><ol><template data-sn-for="x in xs" data-sn-key="x"><li data-sn-text="x"></li></template></ol></template>
      <template data-sn-else><p>hidden</p></template>
      <button data-sn-on-click="show = !show">t</button>
      <button id="add" data-sn-on-click="xs.push('c')">add</button>
    </div>`);
  expect(root.querySelector('p')?.textContent).toBe('hidden');
  expect(root.querySelector('ol')).toBeNull();
  root.querySelector('button')!.click();
  await flush();
  expect(root.querySelector('p')).toBeNull();
  expect([...root.querySelectorAll('li')].map((l) => l.textContent)).toEqual(['a', 'b']);
  root.querySelector<HTMLElement>('#add')!.click();
  await flush();
  expect([...root.querySelectorAll('li')].map((l) => l.textContent)).toEqual(['a', 'b', 'c']);
});

test('resources load, order, filter and expose $meta', async () => {
  const requests = mockRequests({
    'GET /api/people': { people: [{ id: 2, name: 'Bob' }, { id: 1, name: 'ada' }], total: 2 },
  });
  const { root, flush, settle } = await render(`
    <sn-resource name="people" src="/api/people" items="people" total="total" key="id" order="name"></sn-resource>
    <div data-sn-state="{ q: '' }">
      <input data-sn-model="q">
      <p data-sn-show="$meta.people.loading">loading</p>
      <span data-sn-text="$meta.people.total"></span>
      <ul><template data-sn-for="p in people.filter(p => p.name.toLowerCase().includes(q))"><li data-sn-text="p.name"></li></template></ul>
    </div>`, { requests });
  expect(root.querySelector('p')!.hidden).toBe(false);
  await settle();
  expect(root.querySelector('p')!.hidden).toBe(true);
  expect([...root.querySelectorAll('li')].map((l) => l.textContent)).toEqual(['ada', 'Bob']);
  expect(root.querySelector('span')!.textContent).toBe('2');
  input(root.querySelector('input')!, 'b');
  await flush();
  expect([...root.querySelectorAll('li')].map((l) => l.textContent)).toEqual(['Bob']);
});

test('state-dependent src refetches, latest wins, when gates loading', async () => {
  const requests = mockRequests({
    'GET /api/items': (call) => ({ items: [{ id: new URL(call.url, 'http://x').searchParams.get('q') }] }),
  });
  const { root, flush, settle } = await render(`
    <div data-sn-state="{ q: 'a', on: true }">
      <sn-resource name="items" src="/api/items?q={q}" items="items" key="id" when="on"></sn-resource>
      <input data-sn-model="q">
      <button data-sn-on-click="on = !on">t</button>
      <ul><template data-sn-for="it in items"><li data-sn-text="it.id"></li></template></ul>
    </div>`, { requests });
  await settle();
  expect(root.querySelector('li')!.textContent).toBe('a');
  input(root.querySelector('input')!, 'b');
  await flush();
  input(root.querySelector('input')!, 'c');
  await settle();
  expect([...root.querySelectorAll('li')].map((l) => l.textContent)).toEqual(['c']);
  expect(requests.calls.map((c) => c.url)).toEqual(['/api/items?q=a', '/api/items?q=b', '/api/items?q=c']);
  root.querySelector('button')!.click();
  await settle();
  expect(root.querySelectorAll('li')).toHaveLength(0);
});

test('resources with the same src share one request', async () => {
  const requests = mockRequests({ 'GET /api/contacts': { a: [{ id: 1 }], b: [{ id: 2 }] } });
  const { root, settle } = await render(`
    <sn-resource name="a" src="/api/contacts" items="a" key="id"></sn-resource>
    <sn-resource name="b" src="/api/contacts" items="b" key="id"></sn-resource>
    <p data-sn-text="a.length + b.length"></p>`, { requests });
  await settle();
  expect(root.querySelector('p')!.textContent).toBe('2');
  expect(requests.calls).toHaveLength(1);
});

test('embedded data replaces the first request', async () => {
  const requests = mockRequests({});
  const { root, settle } = await render(`<html><head>
    <script type="application/json" data-sn-data="people">[{"id":1,"name":"Ada"}]</script></head><body>
    <sn-resource name="people" src="/api/people" key="id"></sn-resource>
    <ul><template data-sn-for="p in people"><li data-sn-text="p.name"></li></template></ul></body></html>`, { requests });
  await settle();
  expect(root.querySelector('li')!.textContent).toBe('Ada');
  expect(requests.calls).toHaveLength(0);
});

test('forms serialize to nested JSON; then writes the base and closes the dialog', async () => {
  const requests = mockRequests({
    'GET /api/people': [],
    'POST /api/people': (c) => ({ id: 7, ...(c.body as object) }),
  });
  const { root, settle } = await render(`
    <sn-resource name="people" src="/api/people" key="id"></sn-resource>
    <dialog open>
      <form data-sn-post="/api/people" data-sn-then="upsert('people', $result); close()">
        <input name="name" value="Ada">
        <input name="age" type="number" value="36">
        <input name="emails[0].value" value="a@x">
        <input name="vip" type="checkbox" checked>
        <input name="tags" type="checkbox" value="x" checked><input name="tags" type="checkbox" value="y">
        <input name="skip" disabled value="no">
        <button>Save</button>
      </form>
    </dialog>
    <ul><template data-sn-for="p in people"><li data-sn-text="p.name"></li></template></ul>`, { requests });
  await settle();
  root.querySelector('form')!.requestSubmit();
  await settle();
  expect(requests.calls.at(-1)!.body).toEqual({ name: 'Ada', age: 36, emails: [{ value: 'a@x' }], vip: true, tags: ['x'] });
  expect(root.querySelector('li')!.textContent).toBe('Ada');
  expect(root.querySelector('dialog')!.open).toBe(false);
});

test('block mode ignores re-triggers; aria-busy while pending', async () => {
  const requests = mockRequests({ 'POST /api/x': { ok: true } });
  const { root, flush, settle } = await render(`
    <form data-sn-post="/api/x" data-sn-body="{a: 1}"><button>go</button></form>`, { requests });
  const form = root.querySelector('form')!;
  form.requestSubmit();
  await flush();
  expect(form.getAttribute('aria-busy')).toBe('true');
  expect(root.querySelector('button')!.disabled).toBe(true);
  form.requestSubmit();
  await settle();
  expect(requests.calls).toHaveLength(1);
  expect(form.hasAttribute('aria-busy')).toBe(false);
  expect(root.querySelector('button')!.disabled).toBe(false);
});

test('queue sends every trigger in order; latest drops older waiting triggers', async () => {
  const requests = mockRequests({ 'PUT /api/q': null, 'PUT /api/l': null });
  const { root, flush, settle } = await render(`
    <div data-sn-state="{ n: 0 }">
      <button id="q" data-sn-put="/api/q" data-sn-body="{n: n}" data-sn-on-click="n++">q</button>
      <button id="l" data-sn-put="/api/l" data-sn-concurrency="latest" data-sn-body="{n: n}" data-sn-on-click="n++">l</button>
    </div>`, { requests });
  const q = root.querySelector<HTMLElement>('#q')!;
  for (let i = 0; i < 3; i++) { q.click(); await flush(); }
  await settle();
  // the plain handler on the same element runs before the action, so the body sees n already incremented
  expect(requests.calls.map((c) => c.body)).toEqual([{ n: 1 }, { n: 2 }, { n: 3 }]);
  const l = root.querySelector<HTMLElement>('#l')!;
  for (let i = 0; i < 3; i++) { l.click(); await flush(); }
  await settle();
  expect(requests.calls.slice(3).map((c) => c.body)).toEqual([{ n: 4 }, { n: 6 }]);
});

test('debounce delays the trigger', async () => {
  const requests = mockRequests({ 'GET /api/s': [] });
  const { root, flush, advance } = await render(`
    <div data-sn-state="{ q: '' }">
      <input data-sn-model="q" data-sn-get="/api/s?q={q}" data-sn-trigger="input" data-sn-debounce="300">
    </div>`, { requests });
  const el = root.querySelector('input')!;
  input(el, 'a'); await flush();
  await advance(200);
  input(el, 'ab'); await flush();
  await advance(200);
  expect(requests.calls).toHaveLength(0);
  await advance(100);
  expect(requests.calls.map((c) => c.url)).toEqual(['/api/s?q=ab']);
});

test('unhandled errors bubble as sn-error, then reach onError', async () => {
  const seen: string[] = [];
  configure({ onError: (e) => seen.push(`onError:${e.message}`) });
  const requests = mockRequests({ 'POST /api/a': { status: 422, body: { message: 'bad' } }, 'POST /api/b': { status: 500 } });
  const { root, settle } = await render(`
    <div data-sn-state="{ msg: '' }">
      <section data-sn-on-sn-error="msg = $event.detail.error.message; $event.preventDefault()">
        <button id="a" data-sn-post="/api/a">a</button>
      </section>
      <button id="b" data-sn-post="/api/b">b</button>
      <p data-sn-text="msg"></p>
    </div>`, { requests });
  root.querySelector<HTMLElement>('#a')!.click();
  await settle();
  expect(root.querySelector('p')!.textContent).toBe('bad');
  root.querySelector<HTMLElement>('#b')!.click();
  await settle();
  expect(seen).toEqual(['onError:500']);
});

test('catch gets $error with status and body', async () => {
  const requests = mockRequests({ 'DELETE /api/x': { status: 409, body: { message: 'conflict' } } });
  const { root, settle } = await render(`
    <div data-sn-state="{ err: null }">
      <button data-sn-delete="/api/x" data-sn-catch="err = $error.status + ' ' + $error.message">x</button>
      <p data-sn-text="err"></p>
    </div>`, { requests });
  root.querySelector('button')!.click();
  await settle();
  expect(root.querySelector('p')!.textContent).toBe('409 conflict');
});

test('401 goes to login through loginRedirect and never runs then/catch', async () => {
  const { loginRedirect, onUnauthorized } = await import('../../src/index.js');
  configure({ request: [onUnauthorized(loginRedirect({ to: '/login', returnUrl: { allow: ['/app/'] } }))] });
  const requests = mockRequests({ 'POST /api/x': { status: 401 } });
  const { root, settle, navigations } = await render(`
    <div data-sn-state="{ r: 'none' }">
      <button data-sn-post="/api/x" data-sn-then="r = 'then'" data-sn-catch="r = 'catch'">x</button>
      <p data-sn-text="r"></p>
    </div>`, { requests, url: 'http://localhost/app/inbox?x=1' });
  root.querySelector('button')!.click();
  await settle().catch(() => {});
  expect(navigations).toEqual(['/login']);
  expect(root.querySelector('p')!.textContent).toBe('none');
});

test('$url reads and writes query parameters', async () => {
  const { root, flush, url } = await render(`
    <p data-sn-text="$url.tab"></p>
    <button data-sn-on-click="$url.tab = 'b'">b</button>`, { url: 'http://localhost/page?tab=a' });
  expect(root.querySelector('p')!.textContent).toBe('a');
  root.querySelector('button')!.click();
  await flush();
  expect(root.querySelector('p')!.textContent).toBe('b');
  expect(url()).toBe('http://localhost/page?tab=b');
});

test('$now refreshes every minute; helpers format with the locale', async () => {
  const { root, advance } = await render(`
    <p data-sn-text="$now.toISOString()"></p>
    <span data-sn-text="number(1234.5)"></span>`, { now: Date.parse('2026-01-01T00:00:00Z'), locale: 'de-DE' });
  expect(root.querySelector('p')!.textContent).toBe('2026-01-01T00:00:00.000Z');
  expect(root.querySelector('span')!.textContent).toBe('1.234,5');
  await advance(60_000);
  expect(root.querySelector('p')!.textContent).toBe('2026-01-01T00:01:00.000Z');
});

test('$locale assignment re-runs locale-dependent bindings', async () => {
  const { root, flush } = await render(`
    <span data-sn-text="number(1234.5)"></span>
    <button data-sn-on-click="$locale = 'en-US'">en</button>`, { locale: 'de-DE' });
  root.querySelector('button')!.click();
  await flush();
  expect(root.querySelector('span')!.textContent).toBe('1,234.5');
});

test('helper namespaces are called by member', async () => {
  const m = { hello: ({ name }: { name: string }) => `Hello ${name}` };
  const { root } = await render(`<p data-sn-text="m.hello({name: 'Ada'})"></p>`, { helpers: { m } });
  expect(root.querySelector('p')!.textContent).toBe('Hello Ada');
});

test('persisted models restore from storage', async () => {
  const first = await render(`<div data-sn-state="{ q: '' }"><input data-sn-model="q" data-sn-persist="q"></div>`);
  input(first.root.querySelector('input')!, 'hello');
  await first.flush();
  const stored = first.app.env.storage()!.getItem('sn:q');
  expect(stored).toBe('"hello"');
});

test('partials are inlined with lexical scope', async () => {
  const { root } = await render(`
    <div data-sn-state="{ c: { name: 'Ada' } }"><sn-include src="./card.html"></sn-include></div>`,
  { files: { 'card.html': '<b data-sn-text="c.name"></b>' } });
  expect(root.querySelector('b')!.textContent).toBe('Ada');
});

test('islands: props in, events out, state().update()', async () => {
  class XCard extends HTMLElement { data: unknown; }
  if (!customElements.get('x-card')) customElements.define('x-card', XCard);
  const { root, flush, app } = await render(`
    <div data-sn-state="{ item: {n: 1}, got: null }">
      <x-card data-sn-prop="{data: item}" data-sn-on-picked="got = $event.detail"></x-card>
      <p data-sn-text="got"></p><i data-sn-text="item.n"></i>
    </div>`);
  const card = root.querySelector('x-card') as XCard;
  expect(card.data).toEqual({ n: 1 });
  card.dispatchEvent(new CustomEvent('picked', { detail: 'yes', bubbles: true }));
  await flush();
  expect(root.querySelector('p')!.textContent).toBe('yes');
  app.state(card).update((s) => { s.item.n = 2; });
  await flush();
  expect(root.querySelector('i')!.textContent).toBe('2');
});

test('closed dialogs are evaluated when they open', async () => {
  const { root, flush } = await render(`
    <div data-sn-state="{ draft: null }">
      <button data-sn-on-click="draft = {name: 'Ada'}; $el.nextElementSibling.showModal()">edit</button>
      <dialog><input data-sn-model="draft.name"></dialog>
    </div>`);
  root.querySelector('button')!.click();
  await flush();
  const dialog = root.querySelector('dialog')!;
  dialog.dispatchEvent(new Event('toggle'));
  await flush();
  expect(root.querySelector('input')!.value).toBe('Ada');
});

test('list structure changes still update index reads, length and shifted rows', async () => {
  const { root, flush } = await render(`
    <div data-sn-state="{ xs: [{t: 'a'}, {t: 'b'}, {t: 'c'}] }">
      <p data-sn-text="xs[0].t + xs.length"></p>
      <ul><template data-sn-for="(x, i) in xs"><li data-sn-text="i + xs[i].t"></li></template></ul>
      <button id="rm" data-sn-on-click="xs.splice(0, 1)"></button>
      <button id="push" data-sn-on-click="xs.push({t: 'd'})"></button>
    </div>`);
  const lis = () => [...root.querySelectorAll('li')].map((l) => l.textContent);
  root.querySelector<HTMLElement>('#rm')!.click();
  await flush();
  expect(root.querySelector('p')!.textContent).toBe('b2');
  expect(lis()).toEqual(['0b', '1c']);
  root.querySelector<HTMLElement>('#push')!.click();
  await flush();
  expect(root.querySelector('p')!.textContent).toBe('b3');
  expect(lis()).toEqual(['0b', '1c', '2d']);
});

test('rows reading another list by index see that list change', async () => {
  const { root, flush } = await render(`
    <div data-sn-state="{ xs: ['a', 'b'], names: ['A', 'B'] }">
      <template data-sn-for="(x, i) in xs" data-sn-key="x"><i data-sn-text="names[i]"></i></template>
      <button id="sp" data-sn-on-click="names.splice(0, 1, 'Z')"></button>
      <button id="re" data-sn-on-click="names = ['P', 'Q']"></button>
    </div>`);
  const text = () => [...root.querySelectorAll('i')].map((e) => e.textContent).join();
  root.querySelector<HTMLElement>('#sp')!.click();
  await flush();
  expect(text()).toBe('Z,B');
  root.querySelector<HTMLElement>('#re')!.click();
  await flush();
  expect(text()).toBe('P,Q');
});

test('writes through forEach callbacks update exactly the marked rows and index reads', async () => {
  const { root, flush } = await render(`
    <div data-sn-state="{ xs: [{t: 'a'}, {t: 'b'}, {t: 'c'}] }">
      <p data-sn-text="xs[2].t"></p>
      <template data-sn-for="x in xs"><i data-sn-text="x.t"></i></template>
      <button data-sn-on-click="xs.forEach((x, i) => i != 1 && (x.t = x.t.toUpperCase()))"></button>
    </div>`);
  root.querySelector('button')!.click();
  await flush();
  expect([...root.querySelectorAll('i')].map((e) => e.textContent)).toEqual(['A', 'b', 'C']);
  expect(root.querySelector('p')!.textContent).toBe('C');
});

test('marked outer elements update inner rows that read them', async () => {
  const { root, flush } = await render(`
    <div data-sn-state="{ xs: [{t: 'a', ys: [{v: 1}, {v: 2}]}, {t: 'b', ys: [{v: 3}]}] }">
      <template data-sn-for="x in xs"><template data-sn-for="y in x.ys"><i data-sn-text="x.t + y.v"></i></template></template>
      <button data-sn-on-click="xs.forEach((x) => x.t = x.t.toUpperCase())"></button>
    </div>`);
  root.querySelector('button')!.click();
  await flush();
  expect([...root.querySelectorAll('i')].map((e) => e.textContent)).toEqual(['A1', 'A2', 'B3']);
});
