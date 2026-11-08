import { expect, test, vi } from 'vitest';
import { compileParts } from '../../src/compiler/index.js';
import { render } from '../../src/testing/index.js';

const compile = (body: string) => compileParts(`<!DOCTYPE html><html><head></head><body>${body}</body></html>`, {
  file: '/app/index.html', root: '/app', dev: false, readFile: () => '', helpers: { module: null, names: [], namespaces: {} },
});

test('a simple row template gets a creation function; templates with `$el`, state or only handlers do not', () => {
  const { ir, fns } = compile(`
    <div data-sn-state="{ rows: [{id: 1, on: true}], sel: 1 }">
      <template data-sn-for="r in rows"><li class="row" data-sn-class="{active: r.id === sel}" data-sn-on-click="sel = r.id"><b data-sn-text="r.id"></b><i data-sn-show="r.on" data-sn-attr="{title: 'row ' + r.id}"></i></li></template>
      <template data-sn-for="r in rows"><li data-sn-text="$el.localName + r.id"></li></template>
      <template data-sn-for="r in rows"><li data-sn-state="{ open: false }" data-sn-text="r.id"></li></template>
      <template data-sn-for="r in rows"><li data-sn-on-click="sel = r.id"></li></template>
    </div>`);
  const [simple, withEl, withState, handlersOnly] = ir.templates;
  expect(simple!.make).toEqual(expect.any(Number));
  expect(fns[simple!.make!]).toBe(
    '(c, $, w) => { const n0 = c, n1 = n0?.firstChild, n2 = n1?.nextSibling, e0 = n0?.localName == "li" ? n0 : null, e1 = n1?.localName == "b" ? n1 : null, e2 = n2?.localName == "i" ? n2 : null; '
    + "const v0 = e0 ? ($.r.id === $.$s0.sel) : w.U, v1 = e1 ? ($.r.id) : w.U, v2 = e2 ? ($.r.on) : w.U, v3 = e2 ? ('row ' + $.r.id) : w.U; "
    + 'e0 && w.c(e0, "active", v0, 1); e1 && w.t(e1, "", v1); e2 && w.h(e2, "", v2); e2 && w.a(e2, "title", v3); return [v0, v1, v2, v3]; }',
  );
  expect(simple!.nodes[0]!.cl).toBe(1);
  expect(withEl!.make).toBeUndefined();
  expect(withState!.make).toBeUndefined();
  expect(handlersOnly!.make).toBeUndefined();
  expect(handlersOnly!.find).toEqual(expect.any(Number));
});

test('rows created by the creation function behave like bound rows; a throwing expression falls back to the generic path and is reported', async () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const { root, flush } = await render(`
    <div data-sn-state="{ rows: [{id: 1, tags: ['a']}, {id: 2, tags: null}], sel: 1 }">
      <ul><template data-sn-for="r in rows"><li class="row" data-sn-class="{active: r.id === sel}"><b data-sn-text="r.id"></b><i data-sn-text="r.tags.length"></i></li></template></ul>
      <button id="pick" data-sn-on-click="sel = 2">pick</button>
      <button id="fix" data-sn-on-click="rows[1].tags = ['x', 'y']">fix</button>
    </div>`);
  const lis = () => [...root.querySelectorAll('li')].map((li) => `${li.className}|${li.querySelector('b')!.textContent}|${li.querySelector('i')!.textContent}`);
  // row 2's `r.tags.length` throws: the generic path created it, wrote the bindings that work, and warned once for the one that failed
  expect(lis()).toEqual(['row active|1|1', 'row|2|']);
  expect(warn.mock.calls.filter((c) => String(c[0]).includes('[6]') || /tags|length|null/.test(c.join(' '))).length).toBeGreaterThan(0);
  (root.querySelector('#pick') as HTMLElement).click();
  await flush();
  expect(lis()).toEqual(['row|1|1', 'row active|2|']);
  (root.querySelector('#fix') as HTMLElement).click();
  await flush();
  expect(lis()).toEqual(['row|1|1', 'row active|2|2']);
  warn.mockRestore();
});

test('the creation function walks only to elements with value bindings; a handler-only element after them still gets its events', async () => {
  const html = `
    <div data-sn-state="{ rows: [{id: 1}, {id: 2}], sel: 0 }">
      <ul><template data-sn-for="r in rows"><li><b data-sn-text="r.id"></b><span><a data-sn-on-click="sel = r.id">x</a></span></li></template></ul>
      <p data-sn-text="sel"></p>
    </div>`;
  const { ir, fns } = compile(html);
  expect(fns[ir.templates[0]!.make!]).toBe(
    '(c, $, w) => { const n0 = c, n1 = n0?.firstChild, e0 = n1?.localName == "b" ? n1 : null; const v0 = e0 ? ($.r.id) : w.U; e0 && w.t(e0, "", v0); return [v0]; }',
  );
  const { root, flush } = await render(html);
  expect([...root.querySelectorAll('li b')].map((b) => b.textContent)).toEqual(['1', '2']);
  (root.querySelectorAll('a')[1] as HTMLElement).click();
  await flush();
  expect(root.querySelector('p')!.textContent).toBe('2');
});
