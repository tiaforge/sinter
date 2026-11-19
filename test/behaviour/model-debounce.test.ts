// `data-sn-debounce` on a model (an element without an action): the field shows what is typed at once, and
// the model writes once the field pauses. The pause replaces the typing pause, it does not add to it: the
// write is not typing, so a resource over it loads at once and a model on `$url` is one history entry.
import { expect, test } from 'vitest';
import { compile } from '../../src/compiler/index.js';
import { mockRequests, render } from '../../src/testing/index.js';

const input = (el: HTMLInputElement, v: string) => { el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })); };

test('a local filter waits for the pause; the field keeps what is typed', async () => {
  const { root, flush, advance } = await render(`
    <div data-sn-state="{ q: '' }">
      <input data-sn-model="q" data-sn-debounce="300">
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
      <input data-sn-model="q" data-sn-debounce="300">
      <sn-resource name="hits" src="/api/s?q={q}" when="q" key="id"></sn-resource><p data-sn-text="hits.length"></p>
    </div>`, { requests });
  input(root.querySelector('input')!, 'ab'); await flush();
  await advance(299);
  expect(requests.calls).toHaveLength(0);
  await advance(1); await flush();
  expect(requests.calls.map((c) => c.url)).toEqual(['/api/s?q=ab']);
});

test('a debounced model on $url writes one history entry once the field pauses', async () => {
  const { root, flush, advance, url, history } = await render(`<input data-sn-model="$url.q" data-sn-debounce="300">`, { url: 'http://localhost/' });
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
  const { root, flush, advance } = await render(`<div data-sn-state="{ q: '' }"><input data-sn-model="q" data-sn-debounce="5000"><p data-sn-text="q"></p></div>`);
  const el = root.querySelector('input')!;
  input(el, 'ab'); await flush();
  await advance(10); await flush();
  expect(root.querySelector('p')!.textContent).toBe('');
  el.dispatchEvent(new Event('change', { bubbles: true }));
  await advance(0); await flush();
  expect(root.querySelector('p')!.textContent).toBe('ab');
});

test('the compiler: milliseconds; on an element with an action it delays the action, as before', () => {
  const d = (html: string) => compile(`<div data-sn-state="{ q: '' }">${html}</div>`, {
    file: '/p/x.html', root: '/p', dev: false, readFile: () => '', helpers: { module: null, names: [], namespaces: {} },
  });
  expect(d('<input data-sn-model="q" data-sn-debounce="300">').diagnostics).toEqual([]);
  expect(d('<input data-sn-model="q" data-sn-debounce="soon">').diagnostics.map((x) => x.message)).toEqual(['`data-sn-debounce` takes milliseconds']);
  const m = d('<input data-sn-model="q" data-sn-put="/api/q" data-sn-body="{ q }" data-sn-debounce="300">');
  expect(m.diagnostics).toEqual([]);
  expect(m.module).not.toMatch(/"k":"model"[^}]*"ms":300/);
});
