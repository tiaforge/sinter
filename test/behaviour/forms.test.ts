// data-sn-confirm, data-sn-encoding="form", $error.detail, data-sn-listbox and per-event debounce.
import { afterEach, expect, test } from 'vitest';
import { configure } from '../../src/index.js';
import { render, mockRequests } from '../../src/testing/index.js';

const asked: string[] = [];
afterEach(() => { asked.length = 0; configure({ request: [], onError: null, confirm: (q) => globalThis.confirm(q) }); });

test('data-sn-confirm asks first; no means no request, a falsy question means no question', async () => {
  let answer: boolean | Promise<boolean> = false;
  configure({ confirm: (q) => { asked.push(q); return answer; } });
  const requests = mockRequests({ 'DELETE /api/x': null });
  const { root, settle } = await render(`
    <div data-sn-state="{ inTrash: false, n: 0 }">
      <button class="a" data-sn-delete="/api/x" data-sn-confirm="'Delete ' + n + '?'" data-sn-then="n++">a</button>
      <button class="b" data-sn-delete="/api/x" data-sn-confirm="inTrash ? 'Really?' : null" data-sn-then="n++">b</button>
    </div>`, { requests });
  root.querySelector<HTMLButtonElement>('.a')!.click();
  await settle();
  expect(asked).toEqual(['Delete 0?']);
  expect(requests.calls).toHaveLength(0);
  answer = Promise.resolve(true);
  root.querySelector<HTMLButtonElement>('.a')!.click();
  await settle();
  expect(requests.calls).toHaveLength(1);
  root.querySelector<HTMLButtonElement>('.b')!.click();
  await settle();
  expect(asked).toHaveLength(2);            // no question asked
  expect(requests.calls).toHaveLength(2);
});

test('data-sn-encoding="form" sends the body or the form as urlencoded fields', async () => {
  const requests = mockRequests({ 'POST /api/event': { ok: true }, 'POST /api/login': { ok: true } });
  const { root, settle } = await render(`
    <div data-sn-state="{ alarms: ['5', '10'] }">
      <button data-sn-post="/api/event" data-sn-encoding="form" data-sn-body="{summary: 'Lunch & co', allDay: true, alarm: alarms, skip: null}">save</button>
      <form data-sn-post="/api/login" data-sn-encoding="form"><input name="user" value="ada"><input name="tag" value="a"><input name="tag" value="b"></form>
    </div>`, { requests });
  root.querySelector('button')!.click();
  await settle();
  expect(requests.calls[0]!.headers['content-type']).toMatch(/application\/x-www-form-urlencoded/);
  expect(requests.calls[0]!.body).toBe('summary=Lunch+%26+co&allDay=true&alarm=5&alarm=10');
  root.querySelector('form')!.requestSubmit();
  await settle();
  expect(requests.calls[1]!.body).toBe('user=ada&tag=a&tag=b');
});

test('$error.detail: the server\'s words or a thrown message, else null', async () => {
  const requests = mockRequests({
    'POST /api/text': { status: 400, body: 'Name taken' },
    'POST /api/json': { status: 422, body: { error: 'Bad date' } },
    'POST /api/bare': { status: 500 },
  });
  const { root, settle } = await render(`
    <div data-sn-state="{ e: [] }">
      <button class="t" data-sn-post="/api/text" data-sn-catch="e.push($error.detail)">t</button>
      <button class="j" data-sn-post="/api/json" data-sn-catch="e.push($error.detail)">j</button>
      <button class="b" data-sn-post="/api/bare" data-sn-catch="e.push($error.detail ?? 'fallback: ' + $error.message)">b</button>
      <p data-sn-text="e.join('|')"></p>
    </div>`, { requests });
  for (const c of ['t', 'j', 'b']) { root.querySelector<HTMLButtonElement>(`.${c}`)!.click(); await settle(); }
  expect(root.querySelector('p')!.textContent).toBe('Name taken|Bad date|fallback: 500');
});

test('data-sn-listbox: arrows mark an option, Enter and Tab pick it, Escape dismisses', async () => {
  const { root, flush } = await render(`
    <div data-sn-state="{ q: '', open: true, picked: '' }" data-sn-let="{ hits: ['ab', 'ac', 'ad'].filter(w => w.startsWith(q)) }">
      <input data-sn-model="q" data-sn-listbox="hits" data-sn-on-dismiss="open = false">
      <ul id="hits" role="listbox" data-sn-show="open && hits.length">
        <template data-sn-for="w in hits" data-sn-key="w"><li role="option" data-sn-on-click="picked = w; q = ''" data-sn-text="w"></li></template>
      </ul>
      <b data-sn-text="picked"></b>
    </div>`);
  const input = root.querySelector('input')!;
  expect(input.getAttribute('role')).toBe('combobox');
  expect(input.getAttribute('aria-controls')).toBe('hits');
  const key = (k: string) => { const e = new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }); input.dispatchEvent(e); return e.defaultPrevented; };
  const marked = () => [...root.querySelectorAll('li')].findIndex((li) => li.getAttribute('aria-selected') == 'true');
  expect(key('ArrowDown')).toBe(true);
  expect(key('ArrowDown')).toBe(true);
  expect(marked()).toBe(1);
  expect(key('ArrowUp')).toBe(true);
  expect(marked()).toBe(0);
  expect(key('Enter')).toBe(true);
  await flush();
  expect(root.querySelector('b')!.textContent).toBe('ab');
  // Enter without a marked option is not taken (the form may submit)
  expect(key('Enter')).toBe(false);
  input.value = 'ad'; input.dispatchEvent(new Event('input', { bubbles: true }));
  await flush();
  expect(key('Tab')).toBe(true);               // the only option
  await flush();
  expect(root.querySelector('b')!.textContent).toBe('ad');
  expect(key('Escape')).toBe(true);
  await flush();
  expect(root.querySelector('ul')!.hidden).toBe(true);
  expect(key('ArrowDown')).toBe(false);        // hidden list: keys pass through
});

test('dismiss bubbles to a form handler and is cancelable: an input can keep it', async () => {
  const { root, flush } = await render(`
    <form data-sn-state="{ log: '' }" data-sn-on-dismiss="log += 'form;'">
      <input class="a" data-sn-listbox="opts">
      <input class="b" data-sn-listbox="opts" data-sn-on-dismiss="log += 'b;'; $event.preventDefault()">
      <ul id="opts" role="listbox"><li role="option">x</li></ul>
      <b data-sn-text="log"></b>
    </form>`);
  const esc = (sel: string) => root.querySelector(sel)!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
  esc('.a'); await flush();
  esc('.b'); await flush();
  expect(root.querySelector('b')!.textContent).toBe('form;b;');
});

test('data-sn-listbox without an id controls the nearest listbox around the input', async () => {
  const { root, flush } = await render(`
    <div data-sn-state="{ fields: ['to', 'cc'], picked: '' }">
      <template data-sn-for="f in fields" data-sn-key="f">
        <div><input data-sn-listbox>
          <ul role="listbox"><li role="option" data-sn-on-click="picked = f" data-sn-text="f"></li></ul></div>
      </template>
      <b data-sn-text="picked"></b>
    </div>`);
  const input = root.querySelectorAll('input')[1]!;
  for (const k of ['ArrowDown', 'Enter']) input.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));
  await flush();
  expect(root.querySelector('b')!.textContent).toBe('cc');
});

test('data-sn-debounce-<event> delays only that handler', async () => {
  const { root, flush, advance } = await render(`
    <div data-sn-state="{ q: '', blurred: 0, typed: 0, clicks: 0 }">
      <input data-sn-on-input="q = $el.value" data-sn-debounce-input="200" data-sn-on-blur="blurred++">
      <button data-sn-debounce="300" data-sn-on-click="clicks++" data-sn-on-focus="typed++" data-sn-debounce-focus="0">b</button>
      <p data-sn-text="q + '|' + blurred + '|' + clicks + '|' + typed"></p>
    </div>`);
  const input = root.querySelector('input')!, p = root.querySelector('p')!;
  input.value = 'ad'; input.dispatchEvent(new Event('input', { bubbles: true }));
  input.dispatchEvent(new FocusEvent('blur'));
  input.dispatchEvent(new Event('focusout', { bubbles: true }));
  await flush();
  expect(p.textContent).toBe('|1|0|0');          // blur at once, input still waiting
  await advance(200);
  await flush();
  expect(p.textContent).toBe('ad|1|0|0');
  const b = root.querySelector('button')!;
  b.click();
  b.dispatchEvent(new FocusEvent('focus'));
  await flush();
  expect(p.textContent).toBe('ad|1|0|1');        // data-sn-debounce-focus="0" overrides data-sn-debounce
  await advance(300);
  await flush();
  expect(p.textContent).toBe('ad|1|1|1');
});

test('a debounced handler whose row was removed meanwhile does not run', async () => {
  const { root, flush, advance } = await render(`
    <ul data-sn-state="{ items: [{id: 1}], hits: 0 }">
      <template data-sn-for="it in items" data-sn-key="it.id"><li><input data-sn-on-input="hits++" data-sn-debounce="100"></li></template>
      <button data-sn-on-click="items = []">x</button><p data-sn-text="hits"></p></ul>`);
  root.querySelector('input')!.dispatchEvent(new Event('input', { bubbles: true }));
  root.querySelector('button')!.click();
  await flush();
  await advance(200);
  expect(root.querySelector('p')!.textContent).toBe('0');
});
