// Slots that pass data (docs/proposals/component-libraries.md, section 2): `Slot<T>` in the props
// type, `data-sn-prop` on the `<slot>`, `$slot` in the fill; one slot per branch of a chain; a
// `<slot>` inside a fill places the children of the element the default renders.
import { describe, expect, test } from 'vitest';
import { compile } from '../../src/compiler/index.js';

function run(page: string, files: Record<string, string>, o: { dev?: boolean } = {}) {
  const all: Record<string, string> = {};
  for (const [k, v] of Object.entries(files)) all[`/p/src/${k.includes('/') ? k : `components/${k}.html`}`] = v;
  return compile(page, { file: '/p/index.html', root: '/p', dev: !!o.dev, helpers: { module: null, names: [], namespaces: {} }, readFile: (p) => { if (p in all) return all[p]!; throw new Error('missing'); } });
}
const errors = (out: ReturnType<typeof run>) => out.diagnostics.filter((d) => d.severity === 'error').map((d) => `${d.code} ${d.message}`);
const warnings = (out: ReturnType<typeof run>) => out.diagnostics.filter((d) => d.severity === 'warning').map((d) => `${d.code} ${d.message}`);
const body = (out: ReturnType<typeof run>) => /<body>([\s\S]*)<\/body>/.exec(out.html)![1]!.replace(/\s+/g, ' ').trim();

const TABLE = `<template data-sn-component="{ rows: Row[]; columns: (keyof Row)[]; cell: Slot<{ row: Row; column: keyof Row }> }">
  <table><tbody>
    <template data-sn-for="r in rows" data-sn-key="r.id">
      <tr><template data-sn-for="c in columns"><td><slot name="cell" data-sn-prop="{ row: r, column: c }"><span data-sn-text="r[c]"></span></slot></td></template></tr>
    </template>
  </tbody></table>
</template>`;
const INVOICES = '<sn-resource name="invoices" src="/api/invoices" key="id"></sn-resource>';

describe('the declaration: Slot<T>', () => {
  test('a data table with custom cells: `$slot` is inlined, and its row keeps the caller\'s resource', () => {
    const out = run(`${INVOICES}<data-table data-sn-prop="{ rows: invoices, columns: ['number', 'total'] }">
      <span slot="cell" data-sn-text="$slot.column === 'total' ? number($slot.row.total) : $slot.row[$slot.column]" data-sn-on-click="remove($slot.row)"></span>
    </data-table>`, { 'data-table': TABLE });
    expect(errors(out)).toEqual([]);
    expect(body(out)).toContain('<td><span></span></td>');
    expect(out.module).toContain('($) => ($.c === \'total\' ? number($.r.total) : $.r[$k($.c)])');
    // provenance: `remove($slot.row)` acts on the caller's resource
    expect(out.module).toContain('$.$f.remove(["invoices"], $.r)');
  });

  test('unfilled, the placement shows its default; the slot is not a prop to pass', () => {
    const out = run(`${INVOICES}<data-table data-sn-prop="{ rows: invoices, columns: ['number'] }"></data-table>`, { 'data-table': TABLE });
    expect(errors(out)).toEqual([]);
    expect(out.module).toContain('($) => ($.r[$k($.c)])');
  });

  test('passing a slot with `data-sn-prop` on the tag is SN313', () => {
    const out = run(`${INVOICES}<data-table data-sn-prop="{ rows: invoices, columns: [], cell: 1 }"></data-table>`, { 'data-table': TABLE });
    expect(errors(out)).toEqual([expect.stringMatching(/^SN313 `cell` is a slot of `<data-table>` \(`Slot<\{ row: Row; column: keyof Row \}>`\), not a prop/)]);
  });

  test('`?`, a type alias, a member that only contains a slot: SN331', () => {
    const opt = '<template data-sn-component="{ cell?: Slot<{ n: number }> }"><div><slot name="cell" data-sn-prop="{ n: 1 }"><b></b></slot></div></template>';
    expect(errors(run('<x-a></x-a><x-a></x-a>', { 'x-a': opt }))).toEqual([expect.stringMatching(/^SN331 the slot `cell` is written with `\?`/)]);
    const alias = '<template data-sn-component="Props & { cell: Slot<{ n: number }> }"><div></div></template>';
    expect(errors(run('<x-a></x-a>', { 'x-a': alias }))).toEqual([expect.stringMatching(/^SN331 `Slot<T>` is written in the props type literal/)]);
    const inner = '<template data-sn-component="{ cells: Slot<{ n: number }>[] }"><div></div></template>';
    expect(errors(run('<x-a></x-a>', { 'x-a': inner }))).toContainEqual(expect.stringMatching(/^SN331 `cells`: a slot is a member of type `Slot<T>` itself/));
  });

  test('not in a head component or a layout', () => {
    const head = '<template data-sn-head="{ extra: Slot<{ n: number }> }"><title>x</title></template>';
    expect(errors(run('<html><head><x-seo></x-seo></head><body></body></html>', { 'x-seo': head }))).toEqual([expect.stringMatching(/^SN331 `<x-seo>` is a head component: its slots pass nothing/)]);
    const layout = '<!doctype html><html data-sn-layout="{ nav: Slot<{ n: number }> }"><head></head><body><slot></slot></body></html>';
    expect(errors(run('<site-layout><p>x</p></site-layout>', { 'layouts/site-layout.html': layout }))).toEqual([expect.stringMatching(/^SN331 `<site-layout>` is a layout: its slots pass nothing/)]);
  });
});

describe('the placement: data-sn-prop on a <slot>', () => {
  const comp = (slot: string, decl = '{ items: string[]; row: Slot<{ item: string; i: number }> }') => `<template data-sn-component="${decl}"><ul><template data-sn-for="(x, k) in items">${slot}</template></ul></template>`;
  test('a key `T` does not have, a key it needs: SN313', () => {
    const out = run('<x-list data-sn-prop="{ items: [] }"><li slot="row"></li></x-list>', { 'x-list': comp('<slot name="row" data-sn-prop="{ item: x, index: k }"><li></li></slot>') });
    expect(errors(out)).toEqual([
      expect.stringMatching(/^SN313 `index` is not in `Slot<\{ item: string; i: number \}>` of `row`; it passes `item`, `i`/),
      expect.stringMatching(/^SN313 the placement of `row` passes no `i`/),
    ]);
  });

  test('shorthand', () => {
    const C = '<template data-sn-component="{ items: string[]; row: Slot<{ item: string; i: number }> }"><ul><template data-sn-for="(item, i) in items"><slot name="row" data-sn-prop="{ item, i }"><li></li></slot></template></ul></template>';
    const out = run('<x-list data-sn-prop="{ items: [\'a\'] }"><li slot="row" data-sn-text="$slot.item + $slot.i"></li></x-list>', { 'x-list': C });
    expect(errors(out)).toEqual([]);
    expect(out.module).toMatch(/\(\$\) => \(\$\.item\w* \+ \$\.i\w*\)/);
  });

  test('`data-sn-prop` on a slot that is not declared `Slot<T>`, and a `Slot<T>` placed without it: SN331', () => {
    const a = run('<x-list data-sn-prop="{ items: [] }"></x-list>', { 'x-list': comp('<slot name="other" data-sn-prop="{ item: x }"><li></li></slot><slot name="row"><li></li></slot>') });
    expect(errors(a)).toEqual([
      expect.stringMatching(/^SN331 `row` is declared `Slot<\{ item: string; i: number \}>`: its placement passes the values with `data-sn-prop`/),
      expect.stringMatching(/^SN331 `<x-list>` places the slot `other` \(`<slot name="other" data-sn-prop>`\), and no component around it declares `other`/),
    ]);
  });

  test('a placement\'s default is a root: it renders at most one element', () => {
    for (const d of ['<li></li><li></li>', '<template data-sn-for="y in items"><li></li></template>', 'text <li></li>']) {
      const out = run('<x-list data-sn-prop="{ items: [] }"></x-list>', { 'x-list': comp(`<slot name="row" data-sn-prop="{ item: x, i: k }">${d}</slot>`) });
      expect(errors(out)).toEqual([expect.stringMatching(/^SN331 the default of `<slot name="row">` is a root: it renders at most one element/)]);
    }
    // text, nothing, one element, a chain (nested too), a component: allowed
    for (const d of ['', 'none', '<li></li>', '<template data-sn-if="k"><li></li></template><template data-sn-else><li class="first"></li></template>',
      '<template data-sn-if="k"><li></li></template><template data-sn-else><template data-sn-if="x"><li></li></template><template data-sn-else><li class="no"></li></template></template>', '<x-item></x-item>']) {
      expect(errors(run('<x-list data-sn-prop="{ items: [] }"></x-list>', { 'x-list': comp(`<slot name="row" data-sn-prop="{ item: x, i: k }">${d}</slot>`), 'x-item': '<template data-sn-component=""><li></li></template>' }))).toEqual([]);
    }
    // a component default gives a fill no children to place
    const out = run('<x-list data-sn-prop="{ items: [] }"><b slot="row"><slot></slot></b></x-list>', { 'x-list': comp('<slot name="row" data-sn-prop="{ item: x, i: k }"><x-item></x-item></slot>'), 'x-item': '<template data-sn-component=""><li></li></template>' });
    expect(errors(out)).toEqual([expect.stringMatching(/^SN331 the default of `row` in `<x-list>` renders a component \(`<x-item>`\)/)]);
  });
});

describe('the fill: $slot', () => {
  const LIST = '<template data-sn-component="{ items: Item[]; row: Slot<{ item: Item }> }"><ul><template data-sn-for="it in items" data-sn-key="it.id"><slot name="row" data-sn-prop="{ item: it }"><li data-sn-text="it.title"></li></slot></template></ul></template>';
  test('a list with custom rows: the fill writes the caller\'s state and patches the row in its resource', () => {
    const out = run(`<sn-resource name="todos" src="/api/todos" key="id"></sn-resource>
      <div data-sn-state="{ picked: null }"><x-list data-sn-prop="{ items: todos }">
        <li slot="row" data-sn-class="{ done: $slot.item.done }" data-sn-on-click="picked = $slot.item.id; patch($slot.item, { done: !$slot.item.done })" data-sn-text="$slot.item.title"></li>
      </x-list></div>`, { 'x-list': LIST });
    expect(errors(out)).toEqual([]);
    expect(out.module).toContain('$.$s0.picked = $.it.id');
    expect(out.module).toMatch(/\$\.\$f\.patch\(\["todos"\], \$\.it, \{ done: !\$\.it\.done \}\)/);
  });

  test('`$slot` outside a fill, and a key the placement does not pass: SN201', () => {
    expect(errors(run('<p data-sn-text="$slot.x"></p>', {}))).toEqual([expect.stringMatching(/^SN201 `\$slot` is not available here/)]);
    const out = run('<x-list data-sn-prop="{ items: [] }"><li slot="row" data-sn-text="$slot.itme"></li></x-list>', { 'x-list': LIST });
    expect(errors(out)).toEqual([expect.stringMatching(/^SN201 `\$slot.itme` is not passed: the placement of `row` in `<x-list>` passes `item`. Did you mean `item`\?/)]);
    // a fill of a slot that passes nothing has no `$slot`
    const plain = '<template data-sn-component=""><div><slot name="a"></slot></div></template>';
    expect(errors(run('<x-p><b slot="a" data-sn-text="$slot"></b></x-p>', { 'x-p': plain }))).toEqual([expect.stringMatching(/^SN201 `\$slot` is not available here/)]);
  });

  test('`$slot` cannot be assigned', () => {
    const out = run('<x-list data-sn-prop="{ items: [] }"><li slot="row" data-sn-on-click="$slot.item = null"></li></x-list>', { 'x-list': LIST });
    expect(errors(out)).toEqual([expect.stringMatching(/^SN203 `\$slot` is what the placement passes, and cannot be assigned/)]);
  });

  test('an inner `$slot` hides the outer one; a let on the outer fill keeps it', () => {
    const CELL = '<template data-sn-component="{ v: string; label: Slot<{ text: string }> }"><span><slot name="label" data-sn-prop="{ text: v.toUpperCase() }"><i></i></slot></span></template>';
    const out = run(`<sn-resource name="todos" src="/api/todos" key="id"></sn-resource><x-list data-sn-prop="{ items: todos }">
      <li slot="row" data-sn-let="{ outer: $slot.item }"><x-cell data-sn-prop="{ v: $slot.item.title }"><b slot="label" data-sn-text="$slot.text + outer.id"></b></x-cell></li>
    </x-list>`, { 'x-list': LIST, 'x-cell': CELL });
    expect(errors(out)).toEqual([]);
    expect(out.module).toContain('($) => (($.it.title.toUpperCase()) + $.it.id)');
  });

  test('a `<template slot>` starts an if/else chain; anything else is an element', () => {
    const ok = run(`<x-list data-sn-prop="{ items: [] }"><template slot="row" data-sn-if="$slot.item.done"><li class="done"></li></template><template data-sn-else><li></li></template></x-list>`, { 'x-list': LIST });
    expect(errors(ok)).toEqual([]);
    expect(ok.module).toContain('($) => ($.it.done)');
    const bad = run('<x-list data-sn-prop="{ items: [] }"><template slot="row"><li></li></template></x-list>', { 'x-list': LIST });
    expect(errors(bad)).toEqual([expect.stringMatching(/^SN331 a fill of `row` is elements with `slot="row"`; a `<template slot>` is for an if\/else chain/)]);
    const text = run('<x-list data-sn-prop="{ items: [] }"><template slot="row" data-sn-text="$slot.item.title"></template></x-list>', { 'x-list': LIST });
    // a text fill: a text node in the row, with no element
    expect(errors(text)).toEqual([]);
    expect(text.module).toContain('($) => ($.it.title)');
  });

  test('a fill for a slot the component does not have is SN314', () => {
    expect(errors(run('<x-list data-sn-prop="{ items: [] }"><li slot="rows"></li></x-list>', { 'x-list': LIST }))).toEqual([expect.stringMatching(/^SN314 `<x-list>` has no slot `rows`/)]);
  });
});

describe('one slot in each branch of a chain', () => {
  const HEADING = (inner: string) => `<template data-sn-component="{ level: number }"><div>${inner}</div></template>`;
  test('a plain slot placed in both branches: its content is copied into each', () => {
    const out = run('<div data-sn-state="{ t: \'T\' }"><x-h data-sn-prop="{ level: 1 }"><b data-sn-text="t"></b></x-h></div>',
      { 'x-h': HEADING('<template data-sn-if="level === 1"><h1><slot></slot></h1></template><template data-sn-else><h2><slot></slot></h2></template>') });
    expect(errors(out)).toEqual([]);
    expect(out.html).toMatch(/<h1><b><\/b><\/h1>/);
    expect(out.html).toMatch(/<h2><b><\/b><\/h2>/);
    expect(out.module.match(/\(\$\) => \(\$\.\$s0\.t\)/g)?.length).toBe(1);
  });

  test('nested chains are exclusive too; two placements that can render together are SN312', () => {
    const nested = HEADING('<template data-sn-if="level === 1"><h1><slot></slot></h1></template><template data-sn-else><template data-sn-if="level === 2"><h2><slot></slot></h2></template><template data-sn-else><h3><slot></slot></h3></template></template>');
    expect(errors(run('<x-h data-sn-prop="{ level: 2 }"><i>x</i></x-h>', { 'x-h': nested }))).toEqual([]);
    const twice = HEADING('<template data-sn-if="level === 1"><h1><slot></slot></h1></template><p><slot></slot></p>');
    expect(errors(run('<x-h data-sn-prop="{ level: 2 }"><i>x</i></x-h>', { 'x-h': twice }))).toEqual([expect.stringMatching(/^SN312 `<x-h>` has two default slots that can render together/)]);
    const two = HEADING('<template data-sn-if="level === 1"><h1><slot></slot><slot></slot></h1></template><template data-sn-else><h2></h2></template>');
    expect(errors(run('<x-h data-sn-prop="{ level: 2 }"><i>x</i></x-h>', { 'x-h': two }))).toEqual([expect.stringMatching(/^SN312/)]);
  });
});

describe('a <slot> inside a fill', () => {
  const NODE_C = `<template data-sn-component="{ node: { url: string; depth: number; text: string }; link: Slot<{ node: { url: string } }>; heading: Slot<{ node: { depth: number } }> }"><div>
    <slot name="link" data-sn-prop="{ node }"><a data-sn-attr="{ href: node.url }"><em data-sn-text="node.text"></em></a></slot>
    <slot name="heading" data-sn-prop="{ node }"><template data-sn-if="node.depth === 1"><h1><b data-sn-text="node.text"></b></h1></template><template data-sn-else><h2><i data-sn-text="node.text"></i></h2></template></slot>
  </div></template>`;
  const NODE = '<div data-sn-state="{ n: { url: \'/x\', depth: 1, text: \'hi\' } }">';

  test('an unnamed `<slot>` places the children of the element the default renders, in the component\'s scope', () => {
    const out = run(`${NODE}<x-node data-sn-prop="{ node: n }"><a slot="link" rel="nofollow ugc" data-sn-attr="{ href: $slot.node.url }"><slot></slot> ↗</a></x-node></div>`, { 'x-node': NODE_C });
    expect(errors(out)).toEqual([]);
    expect(body(out)).toContain('<a rel="nofollow ugc" data-sn="1"><em data-sn="2"></em> ↗</a>');
    // the children read the component's `node`: the caller's expression, inlined
    expect(out.module).toContain('($) => ($.$s0.n.text)');
  });

  test('a heading fill that picks its level: a chain, with the children in each branch; the default a chain too', () => {
    const out = run(`${NODE}<x-node data-sn-prop="{ node: n }"><template slot="heading" data-sn-if="$slot.node.depth === 1"><h1 class="title"><slot></slot></h1></template><template data-sn-else><h2 class="title"><slot></slot></h2></template></x-node></div>`, { 'x-node': NODE_C });
    expect(errors(out)).toEqual([]);
    // each branch of the fill places the default's children, by the default's own chain
    expect((out.html.match(/<h1 class="title">/g) ?? []).length).toBe(1);
    // (comment anchors: each branch's inner chain is an anchor pair, its templates beside the others)
    expect(out.html).toMatch(/<template id="sn-t-\d+"><h1 class="title"><!--sn--><!--\/sn--><\/h1><\/template><template id="sn-t-\d+"><b><\/b><\/template><template id="sn-t-\d+"><i><\/i><\/template>/);
    expect(out.html).toMatch(/<template id="sn-t-\d+"><h2 class="title"><!--sn--><!--\/sn--><\/h2><\/template><template id="sn-t-\d+"><b><\/b><\/template><template id="sn-t-\d+"><i><\/i><\/template>/);
    expect(out.module).toContain('($) => ($.$s0.n.depth === 1)');
    expect(out.module).toContain('($) => ($.$s0.n.text)');
    // the fill's chain and, in each branch, the default's chain
    expect(out.module.match(/"k":"if"/g)).toHaveLength(3);
  });

  test('a fill without a `<slot>` drops the children', () => {
    const out = run(`${NODE}<x-node data-sn-prop="{ node: n }"><span slot="link" data-sn-text="$slot.node.url"></span></x-node></div>`, { 'x-node': NODE_C });
    expect(errors(out)).toEqual([]);
    expect(body(out)).not.toContain('<em');
  });

  test('two unnamed `<slot>`s that can render together in one fill: SN312; one per branch is allowed', () => {
    const out = run(`${NODE}<x-node data-sn-prop="{ node: n }"><a slot="link"><slot></slot><slot></slot></a></x-node></div>`, { 'x-node': NODE_C });
    expect(errors(out)).toEqual([expect.stringMatching(/^SN312 this fill of `link` places the children twice/)]);
  });

  test('a placement whose default renders no element gives no children: a `<slot>` in its fill is SN331', () => {
    const C = '<template data-sn-component="{ v: string; label: Slot<{ v: string }> }"><p><slot name="label" data-sn-prop="{ v }">plain text</slot></p></template>';
    expect(errors(run('<x-c data-sn-prop="{ v: \'a\' }"><b slot="label"><slot></slot></b></x-c>', { 'x-c': C }))).toEqual([expect.stringMatching(/^SN331 the placement of `label` in `<x-c>` renders no element/)]);
  });

  test('names on the default\'s element that its children read: an error in the library', () => {
    const C = '<template data-sn-component="{ v: string; label: Slot<{ v: string }> }"><p><slot name="label" data-sn-prop="{ v }"><span data-sn-let="{ big: v.toUpperCase() }"><b data-sn-text="big"></b></span></slot></p></template>';
    expect(errors(run('<x-c data-sn-prop="{ v: \'a\' }"></x-c><x-c data-sn-prop="{ v: \'b\' }"></x-c>', { 'x-c': C }))).toEqual([expect.stringMatching(/^SN331 the default of `<slot name="label">` declares `big` on its element, and its children read it/)]);
  });

  test('a fill of a slot that passes nothing is given nothing: its `<slot>`s are the enclosing component\'s, as today', () => {
    const CARD = '<template data-sn-component=""><section><slot name="side"></slot></section></template>';
    const OUTER = '<template data-sn-component=""><div><x-card><aside slot="side"><slot></slot></aside></x-card></div></template>';
    const out = run('<x-outer><b>mine</b></x-outer>', { 'x-card': CARD, 'x-outer': OUTER });
    expect(errors(out)).toEqual([]);
    expect(body(out)).toContain('<aside><b>mine</b></aside>');
  });

  test('a component\'s own default slot cannot be placed inside a fill of a data slot: that `<slot>` is the children', () => {
    const OUTER = `<template data-sn-component="{ node: { url: string; depth: number; text: string } }"><div><x-node data-sn-prop="{ node }"><a slot="link"><slot></slot></a></x-node></div></template>`;
    const out = run(`${NODE}<x-outer data-sn-prop="{ node: n }"><b>page</b></x-outer></div>`, { 'x-node': NODE_C, 'x-outer': OUTER });
    expect(errors(out)).toEqual([expect.stringMatching(/^SN314 `<x-outer>` has no default `<slot>`/)]);
    expect(body(out)).toContain('<a><em data-sn="1"></em></a>');
  });

  test('forwarding passes the children on: a page\'s fill of the wrapper\'s slot places `<slot>`', () => {
    const WRAP = `<template data-sn-component="{ node: { url: string; depth: number; text: string }; link: Slot<{ url: string }> }"><div class="wrap"><x-node data-sn-prop="{ node }"><slot name="link" slot="link" data-sn-prop="{ url: $slot.node.url + '?w' }"><a class="wrapped"><slot></slot></a></slot></x-node></div></template>`;
    const filled = run(`${NODE}<x-wrap data-sn-prop="{ node: n }"><a slot="link" data-sn-attr="{ href: $slot.url }"><slot></slot>!</a></x-wrap></div>`, { 'x-node': NODE_C, 'x-wrap': WRAP });
    expect(errors(filled)).toEqual([]);
    expect(body(filled)).toContain('<a data-sn="1"><em data-sn="2"></em>!</a>');
    expect(filled.module).toContain('$.$s0.n.url + \'?w\'');
    // unfilled: the wrapper's own default is the fill, and its `<slot>` the children too
    const plain = run(`${NODE}<x-wrap data-sn-prop="{ node: n }"></x-wrap></div>`, { 'x-node': NODE_C, 'x-wrap': WRAP });
    expect(errors(plain)).toEqual([]);
    expect(body(plain)).toContain('<a class="wrapped"><em data-sn="1"></em></a>');
  });

  test('a fill that is only an unnamed `<slot>`: the children without their element', () => {
    const BARE = `<template data-sn-component="{ node: { url: string; depth: number; text: string } }"><div><x-node data-sn-prop="{ node }"><slot slot="link"></slot></x-node></div></template>`;
    const out = run(`${NODE}<x-bare data-sn-prop="{ node: n }"></x-bare></div>`, { 'x-node': NODE_C, 'x-bare': BARE });
    expect(errors(out)).toEqual([]);
    expect(body(out)).toMatch(/<div><div> <em data-sn="\d+"><\/em> <!--sn \d+--><!--\/sn--> <\/div>/);
  });

  test('a `<slot>` that no component or fill encloses: on a page, in a page\'s slot content', () => {
    expect(errors(run('<div><slot></slot></div>', {}))).toEqual([expect.stringMatching(/^SN331 this `<slot>` is not in a component or a fill/)]);
    const CARD = '<template data-sn-component=""><section><slot></slot></section></template>';
    expect(errors(run('<x-card><p><slot name="x"></slot></p></x-card>', { 'x-card': CARD }))).toEqual([expect.stringMatching(/^SN331 this `<slot>` is not in a component or a fill/)]);
    // the browser's own templates (declarative shadow DOM) are not sinter's
    expect(errors(run('<my-el><template shadowrootmode="open"><slot></slot></template></my-el>', {}))).toEqual([]);
  });
});

describe('literal ids in repeated markup', () => {
  test('in a page\'s loop, in a component\'s loop: a warning', () => {
    const out = run('<div data-sn-state="{ xs: [1, 2] }"><template data-sn-for="x in xs"><p id="row" data-sn-text="x"></p></template></div>', {});
    expect(warnings(out)).toEqual([expect.stringMatching(/^SN532 `id="row"` is in markup that renders more than once \(a `data-sn-for` row\)/)]);
    const C = '<template data-sn-component="{ xs: number[] }"><ul><template data-sn-for="x in xs"><li id="item" data-sn-text="x"></li></template></ul></template>';
    expect(warnings(run('<x-l data-sn-prop="{ xs: [1] }"></x-l>', { 'x-l': C }))).toEqual([expect.stringMatching(/^SN532 `id="item"`/)]);
    expect(warnings(run('<p id="once">x</p>', {}))).toEqual([]);
  });

  test('in a fill of a slot placed more than once', () => {
    const C = '<template data-sn-component="{ v: string; label: Slot<{ v: string }> }"><p><slot name="label" data-sn-prop="{ v }"><b></b></slot><slot name="label" data-sn-prop="{ v: v + \'!\' }"><b></b></slot></p></template>';
    const out = run('<x-c data-sn-prop="{ v: \'a\' }"><i slot="label" id="lbl" data-sn-text="$slot.v"></i></x-c>', { 'x-c': C });
    expect(errors(out)).toEqual([]);
    expect(warnings(out)).toEqual([expect.stringMatching(/^SN532 `id="lbl"` is in markup that renders more than once \(a fill of a slot placed more than once\)/)]);
    // each copy has its own `$slot`
    expect(out.module).toContain('($) => (((\'a\')))');
    expect(out.module).toContain('($) => (((\'a\') + \'!\'))');
  });
});

describe('around the compiler', () => {
  test('a script\'s `this.props` leaves the slots out; `Slot` is a generated global type', async () => {
    const { withoutSlots } = await import('../../src/compiler/components.js');
    expect(withoutSlots('{ rows: Row[]; cell: Slot<{ row: Row }>; n?: number }')).toBe('{ rows: Row[]; n?: number }');
    expect(withoutSlots('{ cell: Slot<{ row: Row }> }')).toBe('{}');
    expect(withoutSlots('Props')).toBe('Props');
    const { componentTypes } = await import('../../src/components-build.js');
    const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import('node:fs');
    const { join } = await import('node:path');
    const { tmpdir } = await import('node:os');
    const root = mkdtempSync(join(tmpdir(), 'sinter-slot-'));
    try {
      mkdirSync(join(root, 'src/components'), { recursive: true });
      writeFileSync(join(root, 'src/components/x-table.html'), '<template data-sn-component="{ rows: string[]; cell: Slot<{ row: string }> }"><div></div></template>');
      writeFileSync(join(root, 'src/components/x-table.ts'), 'export class XTable {}');
      const d = componentTypes(root)!;
      expect(d).toContain('interface Slot<T> {');
      expect(d).toContain('extends Base<{ rows: string[] }, {}');
      // a type the app exports as `Slot`: SN331
      writeFileSync(join(root, 'src/sinter.types.ts'), 'export type Slot = { start: string };\n');
      const { project } = await import('../../src/project.js');
      expect(project(root).diagnostics.map((x) => `${x.code} ${x.message}`)).toEqual([expect.stringMatching(/^SN331 the types module exports a type named `Slot`/)]);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test('the editor: a tag\'s hover lists what each slot passes', async () => {
    const { tagHover } = await import('../../src/lsp/markup.js');
    const text = TABLE.replace('</td>', '</td><td><slot name="cell" data-sn-prop="{ row: r, column: c }"></slot></td>');
    expect(tagHover('data-table', { kind: 'component', file: '/p/src/components/data-table.html', text }, 'src/components/data-table.html'))
      .toContain('Slots:\n- `cell`, passes `$slot`: `{ row: Row; column: keyof Row }`, with fallback');
  });
});

test('the children a fill\'s `<slot>` places keep the component\'s styles: a scope root of its own', () => {
  const C = '<template data-sn-component="{ t: string; link: Slot<{ t: string }> }"><p><slot name="link" data-sn-prop="{ t }"><a><em data-sn-text="t"></em></a></slot></p></template><style>em { color: red }</style>';
  const out = run('<x-c data-sn-prop="{ t: \'a\' }"><b slot="link"><slot></slot></b></x-c>', { 'x-c': C });
  expect(errors(out)).toEqual([]);
  expect(body(out)).toContain('<p data-sn-c="x-c"><b data-sn-s=""><em data-sn="0" data-sn-s="x-c"></em></b></p>');
});

describe('follow-ups', () => {
  test('names on the default\'s element: an object key or a property of the same name is not a read', () => {
    const C = (child: string) => `<template data-sn-component="{ v: { node: string }; label: Slot<{ node: string }> }"><p><slot name="label" data-sn-prop="{ node: v.node }"><span data-sn-let="{ node: v.node }">${child}</span></slot></p></template>`;
    expect(errors(run('<x-c data-sn-prop="{ v: { node: \'a\' } }"></x-c>', { 'x-c': C('<b data-sn-attr="{ node: v.node }" data-sn-text="v.node"></b>') }))).toEqual([]);
    expect(errors(run('<x-c data-sn-prop="{ v: { node: \'a\' } }"></x-c>', { 'x-c': C('<b data-sn-text="node"></b>') }))).toEqual([expect.stringMatching(/^SN331 the default of `<slot name="label">` declares `node`/)]);
    // shorthand reads it
    expect(errors(run('<x-c data-sn-prop="{ v: { node: \'a\' } }"></x-c>', { 'x-c': C('<b data-sn-attr="{ node }"></b>') }))).toEqual([expect.stringMatching(/^SN331 the default of `<slot name="label">` declares `node`/)]);
  });

  test('an unfilled placement with an empty default still compiles its data-sn-prop', () => {
    const top = '<template data-sn-component="{ v: string; label: Slot<{ v: string }> }"><p><slot name="label" data-sn-prop="{ v: vv }"></slot></p></template>';
    expect(errors(run('<x-c data-sn-prop="{ v: \'a\' }"></x-c>', { 'x-c': top }))).toEqual([expect.stringMatching(/^SN201 `vv` is not defined here/)]);
    const row = '<template data-sn-component="{ xs: string[]; label: Slot<{ v: string; i: number }> }"><p><template data-sn-for="x in xs"><slot name="label" data-sn-prop="{ v: x }"></slot></template></p></template>';
    expect(errors(run('<x-c data-sn-prop="{ xs: [] }"></x-c>', { 'x-c': row }))).toEqual([expect.stringMatching(/^SN313 the placement of `label` passes no `i`/)]);
  });
});
