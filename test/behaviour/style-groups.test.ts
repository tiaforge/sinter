// An element's `data-sn-style` entries are one binding in the page module (compile.ts, groupStyles): one
// function returns the values in the order of the names, listed once per distinct list (`ir.sg`), and the
// runtime writes those that changed. It must write exactly what one binding per property wrote.
import { describe, expect, test } from 'vitest';
import { compile } from '../../src/compiler/index.js';
import { render } from '../../src/testing/index.js';

const STYLES = `{ color: s.color, 'font-size': s['font-size'], 'margin-top': s['margin-top'] }`;

describe('style groups', () => {
  test('one binding per element, the names listed once for elements with the same list', () => {
    // (both objects written by the handler: nothing here is a build-time constant)
    const out = compile(`<!doctype html><html><head></head><body><div data-sn-state="{ s: { color: 'red' }, t: { color: 'blue' }, w: 1 }"><i id="w" data-sn-on-click="s = t; t = s; w = 2"></i>
      <p data-sn-style="${STYLES}"></p><p data-sn-style="${STYLES.replace(/\bs\b/g, 't')}"></p><b data-sn-style="{ color: s.color, width: w + 'px' }"></b></div></body></html>`, {
      file: '/p/index.html', root: '/p', dev: false, prerender: true, helpers: { module: null, names: [], namespaces: {} }, readFile: () => { throw new Error('no files'); },
    });
    expect(out.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    const ir = JSON.parse(/const ir = (.*);\n/.exec(out.module)![1]!) as { roots: Array<{ b: Array<{ k: string; g?: number; n?: string }> }>; sg: string[][] };
    const styles = ir.roots.flatMap((n) => n.b).filter((b) => b.k === 'style');
    expect(styles.map((b) => [b.g, b.n])).toEqual([[0, undefined], [0, undefined], [1, undefined]]);
    expect(ir.sg).toEqual([['color', 'font-size', 'margin-top'], ['color', 'width']]);
    // one object read under its own names: read once
    expect(out.module).toMatch(/\(\(o\) => \[o\.color, o\["font-size"\], o\["margin-top"\]\]\)\(\$\./);
  });

  test('values follow state; null removes; a style object changed in place is written', async () => {
    const page = `<div data-sn-state="{ s: { color: 'red', 'font-size': '10px', 'margin-top': null } }">
      <i id="swap" data-sn-on-click="s = { color: 'blue', 'font-size': null, 'margin-top': '3px' }"></i>
      <i id="poke" data-sn-on-click="s.color = 'green'"></i>
      <p id="p" data-sn-style="${STYLES}"></p></div>`;
    const { root, flush } = await render(page);
    await flush();
    const p = root.querySelector('#p') as HTMLElement;
    const css = () => ['color', 'font-size', 'margin-top'].map((n) => p.style.getPropertyValue(n));
    expect(css()).toEqual(['red', '10px', '']);
    (root.querySelector('#swap') as HTMLElement).click();
    await flush();
    expect(css()).toEqual(['blue', '', '3px']);
    (root.querySelector('#poke') as HTMLElement).click();
    await flush();
    expect(css()).toEqual(['green', '', '3px']);
  });

  test("in rows: each row its own values, and a change of one row's item", async () => {
    const page = `<div data-sn-state="{ rows: [{ id: 1, s: { color: 'red' } }, { id: 2, s: { color: 'blue', 'font-size': '9px' } }] }">
      <i id="edit" data-sn-on-click="rows = [rows[0], { id: 2, s: { color: 'teal' } }]"></i>
      <ul><template data-sn-for="r in rows" data-sn-key="r.id"><li data-sn-style="{ color: r.s.color, 'font-size': r.s['font-size'], 'margin-top': r.s['margin-top'] }"></li></template></ul></div>`;
    const { root, flush } = await render(page);
    await flush();
    const css = () => [...root.querySelectorAll('li')].map((li) => `${(li as HTMLElement).style.color}/${(li as HTMLElement).style.fontSize}`);
    expect(css()).toEqual(['red/', 'blue/9px']);
    (root.querySelector('#edit') as HTMLElement).click();
    await flush();
    expect(css()).toEqual(['red/', 'teal/']);
  });

  test("entries that are not one object's own names: grouped as they are", async () => {
    const { root, flush } = await render(`<div data-sn-state="{ big: true, c: 'navy' }"><i id="t" data-sn-on-click="big = !big"></i><p id="p" data-sn-style="{ color: c, 'font-size': big ? '20px' : '10px', width: (big ? 2 : 1) * 10 + 'px' }"></p></div>`);
    await flush();
    const p = root.querySelector('#p') as HTMLElement;
    expect([p.style.color, p.style.fontSize, p.style.width]).toEqual(['navy', '20px', '20px']);
    (root.querySelector('#t') as HTMLElement).click();
    await flush();
    expect([p.style.color, p.style.fontSize, p.style.width]).toEqual(['navy', '10px', '10px']);
  });

  test('an unsafe value is refused per property, the others written', async () => {
    const { root, flush } = await render(`<div data-sn-state="{ u: 'url(https://x.example/a)' }"><p id="p" data-sn-style="{ color: 'red', background: u }"></p></div>`);
    await flush();
    const p = root.querySelector('#p') as HTMLElement;
    expect(p.style.color).toBe('red');
    expect(p.style.background).toBe('');
  });
});
