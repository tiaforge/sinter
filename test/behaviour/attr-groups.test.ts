// An element's `data-sn-attr` entries are one binding in the page module (compile.ts, groupAttrs), as its
// styles are: one function returns the values in the order of the names (`ir.ag`), and the runtime writes
// each through the attribute writer. It must write exactly what one binding per attribute wrote.
import { describe, expect, test } from 'vitest';
import { compile } from '../../src/compiler/index.js';
import { render } from '../../src/testing/index.js';

const ATTRS = `{ title: a.title, lang: a.lang, href: a.href }`;

describe('attribute groups', () => {
  test('one binding per element; the form state attributes are bound on their own', () => {
    const out = compile(`<!doctype html><html><head></head><body><div data-sn-state="{ a: { title: 't' }, v: 'x' }"><i id="w" data-sn-on-click="a = { title: 'u' }; v = 'y'"></i>
      <a data-sn-attr="${ATTRS}"></a><input data-sn-attr="{ value: v, title: a.title, placeholder: v }"></div></body></html>`, {
      file: '/p/index.html', root: '/p', dev: false, prerender: true, helpers: { module: null, names: [], namespaces: {} }, readFile: () => { throw new Error('no files'); },
    });
    expect(out.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    const ir = JSON.parse(/const ir = (.*);\n/.exec(out.module)![1]!) as { roots: Array<{ b: Array<{ k: string; g?: number; n?: string; o?: 1 }> }>; ag: string[][] };
    const attrs = ir.roots.flatMap((n) => n.b).filter((b) => b.k === 'attr');
    expect(attrs.map((b) => [b.g, b.n, b.o])).toEqual([[0, undefined, 1], [undefined, 'value', undefined], [1, undefined, undefined]]);
    expect(ir.ag).toEqual([['title', 'lang', 'href'], ['title', 'placeholder']]);
  });

  test('values follow state; null removes; an unsafe URL is refused, the others written', async () => {
    const page = `<div data-sn-state="{ a: { title: 'one', lang: 'en', href: 'https://x.example/' } }">
      <i id="swap" data-sn-on-click="a = { title: 'two', href: 'javascript:alert(1)' }"></i>
      <a id="l" data-sn-attr="${ATTRS}">x</a></div>`;
    const { root, flush } = await render(page);
    await flush();
    const l = root.querySelector('#l') as HTMLElement;
    const read = () => ['title', 'lang', 'href'].map((n) => l.getAttribute(n));
    expect(read()).toEqual(['one', 'en', 'https://x.example/']);
    (root.querySelector('#swap') as HTMLElement).click();
    await flush();
    expect(read()).toEqual(['two', null, null]);
  });

  test('in rows: a new row writes only the attributes it has', async () => {
    const { root, flush } = await render(`<div data-sn-state="{ rows: [{ id: 1, a: { title: 'x' } }, { id: 2, a: {} }] }">
      <ul><template data-sn-for="r in rows" data-sn-key="r.id"><li data-sn-attr="{ title: r.a.title, lang: r.a.lang, dir: r.a.dir }"></li></template></ul></div>`);
    await flush();
    expect([...root.querySelectorAll('li')].map((li) => li.getAttributeNames())).toEqual([['title'], []]);
  });
});
