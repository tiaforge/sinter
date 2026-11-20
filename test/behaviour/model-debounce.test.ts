// `data-sn-model-debounce`: the field shows what is typed at once, and
// the model writes once the field pauses. The pause replaces the typing pause, it does not add to it: the
// write is not typing, so a resource over it loads at once and a model on `$url` is one history entry.
import { expect, test } from 'vitest';
import { compile } from '../../src/compiler/index.js';
import { mockRequests, render } from '../../src/testing/index.js';

const input = (el: HTMLInputElement, v: string) => { el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })); };

test('a local filter waits for the pause; the field keeps what is typed', async () => {
  const { root, flush, advance } = await render(`
    <div data-sn-state="{ q: '' }">
      <input data-sn-model="q" data-sn-model-debounce="300">
      <ul><template data-sn-for="w in ['apple', 'apricot', 'banana'].filter((w) => w.includes(q))"><li data-sn-text="w"></li></template></ul>
    </div>`);
  const el = root.querySelector('input')!;
  const shown = () => [...root.querySelectorAll('li')].map((l) => l.textContent).join(',');
  input(el, 'a'); await flush();
  await advance(200);
  input(el, 'ap'); await flush();
  await advance(200);
  expect(shown()).toBe('apple,apricot,banana');
  expect(el.value).toBe('ap');
  await advance(100); await flush();
  expect(shown()).toBe('apple,apricot');
});

test('a resource over a debounced model loads right after the pause, not 250 ms later', async () => {
  const requests = mockRequests({ 'GET /api/s': [] });
  const { root, flush, advance } = await render(`
    <div data-sn-state="{ q: '' }">
      <input data-sn-model="q" data-sn-model-debounce="300">
      <sn-resource name="hits" src="/api/s?q={q}" when="q" key="id"></sn-resource><p data-sn-text="hits.length"></p>
    </div>`, { requests });
  input(root.querySelector('input')!, 'ab'); await flush();
  await advance(299);
  expect(requests.calls).toHaveLength(0);
  await advance(1); await flush();
  expect(requests.calls.map((c) => c.url)).toEqual(['/api/s?q=ab']);
});

test('a debounced model on $url writes one history entry once the field pauses', async () => {
  const { root, flush, advance, url, history } = await render(`<input data-sn-model="$url.q" data-sn-model-debounce="300">`, { url: 'http://localhost/' });
  const el = root.querySelector('input')!;
  input(el, 'a'); await flush();
  await advance(100);
  input(el, 'ab'); await flush();
  expect(url()).toBe('http://localhost/');
  await advance(300); await flush();
  expect(url()).toBe('http://localhost/?q=ab');
  expect(history()).toEqual(['http://localhost/', 'http://localhost/?q=ab']);
});

test('Enter or leaving the field (`change`) writes at once', async () => {
  const { root, flush, advance } = await render(`<div data-sn-state="{ q: '' }"><input data-sn-model="q" data-sn-model-debounce="5000"><p data-sn-text="q"></p></div>`);
  const el = root.querySelector('input')!;
  input(el, 'ab'); await flush();
  await advance(10); await flush();
  expect(root.querySelector('p')!.textContent).toBe('');
  el.dispatchEvent(new Event('change', { bubbles: true }));
  await advance(0); await flush();
  expect(root.querySelector('p')!.textContent).toBe('ab');
});

test('the compiler: milliseconds; data-sn-debounce stays the action\'s, data-sn-model-debounce the model\'s', () => {
  const d = (html: string) => compile(`<div data-sn-state="{ q: '' }">${html}</div>`, {
    file: '/p/x.html', root: '/p', dev: false, readFile: () => '', helpers: { module: null, names: [], namespaces: {} },
  });
  expect(d('<input data-sn-model="q" data-sn-model-debounce="300">').diagnostics).toEqual([]);
  expect(d('<input data-sn-model="q" data-sn-model-debounce="soon">').diagnostics.map((x) => x.message)).toEqual(['`data-sn-model-debounce` takes milliseconds']);
  const m = d('<input data-sn-model="q" data-sn-put="/api/q" data-sn-body="{ q }" data-sn-debounce="300">');
  expect(m.diagnostics).toEqual([]);
  expect(m.module).not.toMatch(/"k":"model"[^}]*"ms":300/);
  // the model and the action each wait by their own attribute, together
  const both = d('<input data-sn-model="q" data-sn-put="/api/q" data-sn-body="{ q }" data-sn-debounce="800" data-sn-model-debounce="200">');
  expect(both.diagnostics).toEqual([]);
  expect(both.module).toMatch(/"k":"model"[^}]*"ms":200/);
  // plain data-sn-debounce on a model alone names the attribute it takes
  expect(d('<input data-sn-model="q" data-sn-debounce="200">').diagnostics.map((x) => x.message)).toEqual(['`data-sn-debounce` delays an action\'s trigger, and this element has none; delay the model with `data-sn-model-debounce="200"`']);
  // with a model and a handler: each part named with its own attribute, the model's only if missing
  expect(d('<input data-sn-model="q" data-sn-on-input="q = q" data-sn-debounce="100">').diagnostics.map((x) => x.message)).toEqual(['`data-sn-debounce` delays an action\'s trigger, and this element has none; delay the model with `data-sn-model-debounce="100"`, and the handler with `data-sn-debounce-input="100"`']);
  // the name `model` is an event like any other in the handler family
  expect(d('<input data-sn-on-model="q = 1" data-sn-debounce-model="100">').diagnostics).toEqual([]);
  expect(d('<p data-sn-model-debounce="200"></p>').diagnostics.map((x) => x.message)).toEqual(['`data-sn-model-debounce` needs `data-sn-model` on the same element']);
});

test('Enter in a form: the change writes at once, so the submit sends what was typed', async () => {
  const requests = mockRequests({ 'POST /api/s': {} });
  const r = await render(`<div data-sn-state="{ q: '' }"><form data-sn-post="/api/s" data-sn-body="{ q }"><input data-sn-model="q" data-sn-model-debounce="300"></form></div>`, { requests });
  const el = r.root.querySelector('input')!;
  input(el, 'ab');
  el.dispatchEvent(new Event('change', { bubbles: true }));
  r.root.querySelector('form')!.requestSubmit();
  await r.settle();
  expect(requests.calls.map((c) => c.body)).toEqual([{ q: 'ab' }]);
});

test('data-sn-model-debounce="0" is no debounce: a model on $url types as without it', async () => {
  const { root, flush, advance, history } = await render(`<input data-sn-model="$url.q" data-sn-model-debounce="0">`, { url: 'http://localhost/' });
  const el = root.querySelector('input')!;
  for (const v of ['a', 'ab', 'abc']) { input(el, v); await flush(); }
  await advance(1000); await flush();
  expect(history()).toEqual(['http://localhost/', 'http://localhost/?q=abc']);
});

test('not on a component\'s tag: a component waits inside', () => {
  const files: Record<string, string> = { '/p/src/components/my-field.html': '<template data-sn-props="{ value: string }" data-sn-emits="{ change: string }"><input data-sn-attr="{ value }"></template>' };
  const d = compile('<div data-sn-state="{ q: \'\' }"><my-field data-sn-model="q" data-sn-model-debounce="200"></my-field></div>', {
    file: '/p/x.html', root: '/p', dev: false, readFile: (f) => { if (f in files) return files[f]!; throw new Error('missing'); }, helpers: { module: null, names: [], namespaces: {} },
  }).diagnostics.map((x) => x.message);
  expect(d).toEqual(['`data-sn-model-debounce` cannot be on a component\'s tag']);
});
