// One flush on a mounted page (happy-dom): how the cost of matching dirty paths grows with
// the number of root bindings, and a server event landing in a long sorted list.
// happy-dom's DOM is slower than a browser's; the matching cases write one text node.
//   npm run bench
import { test } from 'vitest';
import type { App } from '../../src/runtime/app.js';
import { items, measure, page } from './page.js';

/** `n` root text bindings over `n` state fields. */
function bindings(n: number) {
  const fields = Array.from({ length: n }, (_, i) => `f${i}: ${i}`).join(', ');
  const spans = Array.from({ length: n }, (_, i) => `<span data-sn-text="f${i}"></span>`).join('');
  return `<html><body><section data-sn-state="{ ${fields} }">${spans}</section></body></html>`;
}

function list(n: number) {
  const rows = JSON.stringify({ rows: items(n) });
  return `<html><head><script type="application/json" data-sn-data="rows">${rows}</script></head><body>
    <sn-resource name="rows" src="/api/rows" items="rows" key="id" order="name"></sn-resource>
    <p data-sn-text="rows.length"></p>
    <ul><template data-sn-for="r in rows"><li><b data-sn-text="r.name"></b> <i data-sn-text="r.score"></i></li></template></ul>
  </body></html>`;
}

test('flush', () => {
  let app: App, el: Element, v = 0, i = 0;
  measure('flush, one state field of many changes (one text node written)', [100, 500, 2000].map((n) => ({
    name: `${n} root bindings`,
    setup: () => { app = page(bindings(n)); el = document.querySelector('span')!; },
    run: () => { app.state(el).update((s) => { s.f0 = ++v; }); app.flush(); },
  })));
  measure('flush, one server upsert into a sorted list (store + reconcile)', [1000, 5000].map((n) => ({
    name: `${n} rows`,
    setup: () => { app = page(list(n)); i = 0; },
    run: () => { app.resource('rows').upsert({ id: i % n, name: `renamed ${i++}`, score: 1 }); app.flush(); },
  })));
  // the selection index (select.ts): only the rows that were and become selected re-render
  measure('flush, a selection moves to another row (`r.id === sel`)', [1000, 5000].map((n) => ({
    name: `${n} rows`,
    setup: () => { app = page(selection(n)); el = document.querySelector('section')!; i = 0; },
    run: () => { app.state(el).update((s) => { s.sel = (i++ * 7) % n; }); app.flush(); },
  })));
});

function selection(n: number) {
  const rows = JSON.stringify({ rows: items(n) });
  return `<html><head><script type="application/json" data-sn-data="rows">${rows}</script></head><body>
    <sn-resource name="rows" src="/api/rows" items="rows" key="id"></sn-resource>
    <section data-sn-state="{ sel: -1 }"><ul><template data-sn-for="r in rows"><li data-sn-class="{danger: r.id === sel}"><b data-sn-text="r.name"></b></li></template></ul></section>
  </body></html>`;
}
