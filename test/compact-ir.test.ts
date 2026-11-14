// What the page module's IR (`compactIR`) carries so that the mount does not work it out from the
// bindings: decided once, at build time.
import { describe, expect, test } from 'vitest';
import { compileParts } from '../src/compiler/index.js';
import { compactIR } from '../src/ir.js';
import { render } from '../src/testing/index.js';

const compact = (html: string) => {
  const parts = compileParts(html, { file: '/p/x.html', root: '/p', dev: false, readFile: () => '', helpers: { module: null, names: [], namespaces: {} } });
  expect(parts.diagnostics.filter((d) => d.severity == 'error')).toEqual([]);
  return compactIR(parts.ir);
};

describe('the event types the mount listens for', () => {
  test('each handler\'s type once, rows included; none on a page without handlers', () => {
    const ir = compact(`<html><body data-sn-state="{ n: 0, rows: [1, 2] }">
      <button data-sn-on-click="n++">a</button><button data-sn-on-click="n--">b</button>
      <template data-sn-for="r in rows"><p data-sn-on-pointerdown="n = r" data-sn-text="r"></p></template>
      <template data-sn-if="n"><b data-sn-on-sn-custom="n = 0">x</b></template>
    </body></html>`);
    expect(ir.ev).toEqual(['click', 'pointerdown', 'sn-custom']);
    expect(compact('<html><body data-sn-state="{ n: 1 }"><p data-sn-text="n + $url.q"></p></body></html>').ev).toBeUndefined();
  });

  test('a text model: input and change; another control or an element in a dialog: toggle too', () => {
    expect(compact('<html><body data-sn-state="{ q: \'\' }"><input data-sn-model="q"></body></html>').ev).toEqual(['input', 'change']);
    expect(compact('<html><body data-sn-state="{ on: false }"><input type="checkbox" data-sn-model="on"></body></html>').ev).toEqual(['toggle', 'input', 'change']);
    expect(compact('<html><body data-sn-state="{ n: 1 }"><dialog id="d"><p data-sn-text="n"></p></dialog></body></html>').ev).toEqual(['toggle']);
  });

  test('the mount listens for exactly those', async () => {
    const types: string[] = [];
    const add = EventTarget.prototype.addEventListener;
    EventTarget.prototype.addEventListener = function (this: EventTarget, type: string, ...rest: any[]) { types.push(type); return (add as any).call(this, type, ...rest); };
    try {
      const { root, flush } = await render('<div data-sn-state="{ n: 0 }"><button data-sn-on-click="n++">a</button><p data-sn-on-dblclick="n = 10" data-sn-text="n"></p></div>');
      expect(types.filter((t) => ['click', 'dblclick', 'toggle', 'input', 'change'].includes(t))).toEqual(['click', 'dblclick']);
      root.querySelector('button')!.click();
      await flush();
      expect(root.querySelector('p')!.textContent).toBe('1');
    } finally { EventTarget.prototype.addEventListener = add; }
  });
});

describe('a template\'s kind', () => {
  const page = (rows: string) => compact(`<html><body data-sn-state="{ rows: [{ id: 1, kids: [1] }], on: true, q: '' }">
    <template data-sn-for="(r, i) in rows">${rows}</template></body></html>`);

  test('simple (`sm`): a row template with only value bindings and handlers', () => {
    expect(page('<p data-sn-text="r.id" data-sn-on-click="q = r.id"></p>').templates[0]!.sm).toBe(1);
    // a model, a state scope, a nested template, a dialog: binding objects
    expect(page('<p><input data-sn-model="q"></p>').templates[0]!.sm).toBeUndefined();
    expect(page('<p data-sn-state="{ open: false }" data-sn-text="r.id"></p>').templates[0]!.sm).toBeUndefined();
    expect(page('<p><template data-sn-if="on"><b data-sn-text="r.id"></b></template></p>').templates[0]!.sm).toBeUndefined();
    expect(page('<dialog><b data-sn-text="r.id"></b></dialog>').templates[0]!.sm).toBeUndefined();
    // an if branch has no lookup function: never simple
    const ir = compact('<html><body data-sn-state="{ on: true, q: 1 }"><template data-sn-if="on"><b data-sn-text="q"></b></template></body></html>');
    expect(ir.templates[0]!.sm).toBeUndefined();
  });

  test('index readers (`ri`): a binding in the rows reads a loop index, nested templates included', () => {
    expect(page('<p data-sn-text="r.id"></p>').templates[0]!.ri).toBeUndefined();
    expect(page('<p data-sn-text="i + 1"></p>').templates[0]!.ri).toBe(1);
    const nested = page('<p><template data-sn-if="on"><b data-sn-text="i"></b></template></p>');
    expect(nested.templates.map((t) => t.ri)).toEqual([1, 1]);
    const inner = page('<p><template data-sn-for="(k, j) in r.kids"><b data-sn-text="j"></b></template></p>');
    expect(inner.templates.find((t) => t.item == 'r')!.ri).toBe(1);
  });

  test('rows that only moved re-run the bindings that read their index', async () => {
    const { root, flush } = await render(`<div data-sn-state="{ rows: [{ id: 'a' }, { id: 'b' }, { id: 'c' }] }">
      <ul><template data-sn-for="(r, i) in rows" data-sn-key="r.id"><li data-sn-text="i + ':' + r.id"></li></template></ul>
      <button data-sn-on-click="rows.reverse()">r</button></div>`);
    const li = () => [...root.querySelectorAll('li')].map((e) => e.textContent);
    expect(li()).toEqual(['0:a', '1:b', '2:c']);
    root.querySelector('button')!.click();
    await flush();
    expect(li()).toEqual(['0:c', '1:b', '2:a']);
  });
});
