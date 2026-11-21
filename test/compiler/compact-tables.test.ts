// @vitest-environment jsdom
// A build's last pass over the page's tables (compile.ts, compactTables): the templates nothing renders (those
// shareTemplates pointed at the one it kept) and the functions nothing calls (`0`: grouped styles, shared copies) are
// out of the page module, the rest numbered again; a template's id is its index, so the page module has none.
import { describe, expect, test } from 'vitest';
import { compile } from '../../src/compiler/index.js';
import { render } from '../../src/testing/index.js';

const INLINES = "{ text: 'x-text', em: 'x-em', strong: 'x-strong' }";
const kids = `<template data-sn-for="n in node.children"><sn-component use="${INLINES}[n.type]" data-sn-with="{ node: n }"></sn-component></template>`;
const COMPONENTS: Record<string, string> = {
  'x-doc': `<template data-sn-props="{ doc: any }"><p class="doc"><template data-sn-for="b in doc.children"><sn-component use="${INLINES}[b.type]" data-sn-with="{ node: b }"></sn-component></template></p></template>`,
  'x-text': '<template data-sn-props="{ node: any }"><span data-sn-text="node.value"></span></template>',
  'x-em': `<template data-sn-props="{ node: any }"><em data-sn-attr="{ title: node.note }">${kids}</em></template>`,
  'x-strong': `<template data-sn-props="{ node: any }"><strong data-sn-attr="{ title: node.note }">${kids}</strong></template>`,
};
const DOC = "{ children: [{ type: 'em', note: 'e', children: [{ type: 'text', value: 'a' }, { type: 'strong', note: 's', children: [{ type: 'text', value: 'b' }] }] }] }";
// shared loops (x-em's and x-strong's), grouped styles in a row (their one-property functions go), an early branch
const PAGE = `<html><head></head><body><div data-sn-state="{ doc: ${DOC}, rows: [{ c: 'red', w: '1px' }], open: true }">
  <button id="clear" data-sn-on-click="doc = { children: [] }; rows = [{ c: 'blue', w: '2px' }]; open = false"></button>
  <x-doc data-sn-with="{ doc }"></x-doc>
  <template data-sn-if="open"><i>open</i></template>
  <ul><template data-sn-for="r in rows"><li data-sn-style="{ color: r.c, 'border-width': r.w }" data-sn-text="r.c"></li></template></ul>
</div></body></html>`;

const build = (dev: boolean) => compile(PAGE, {
  file: '/test/index.html', root: '/test', dev, prerender: true, early: { module: null }, moduleSrc: '/m.js',
  helpers: { module: null, names: [], namespaces: {} }, componentNames: Object.keys(COMPONENTS),
  readFile: (p) => { const n = /components\/([\w-]+)\.html$/.exec(p)?.[1]; if (n && COMPONENTS[n]) return COMPONENTS[n]; throw new Error(`no such file: ${p}`); },
});
const tables = (module: string) => {
  const ir = JSON.parse(/^const ir = (.*);$/m.exec(module)![1]!);
  const fns = /^const fns = \[\n([\s\S]*?)\n\];$/m.exec(module)![1]!.split('\n');
  return { ir, fns };
};

describe('the page module\'s tables, compacted', () => {
  test('no template nothing renders, no template id, no `0` function; the anchors and head templates follow', () => {
    const dev = build(true), out = build(false);
    expect(out.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    const before = tables(dev.module), { ir, fns } = tables(out.module);
    // (a dev build keeps them all: a copy of each loop, the grouped styles' functions as `0`)
    expect(before.fns.filter((f) => f.trim() === '0,').length).toBeGreaterThan(0);
    expect(ir.templates.length).toBeLessThan(before.ir.templates.length);
    expect(ir.templates.some((t: object) => 'id' in t)).toBe(false);
    expect(fns.filter((f) => f.trim() === '0,')).toEqual([]);
    // every template is rendered by an anchor, and every head template is one of them
    const refs = new Set<number>();
    for (const n of [...ir.roots, ...ir.templates.flatMap((t: { nodes: unknown[] }) => t.nodes)]) for (const b of n.b) {
      if (b.k === 'for' || b.k === 'if') { refs.add(b.x); if (b.z != null) refs.add(b.z); }
      if (b.k === 'ch') for (const x of b.c) refs.add(x);
    }
    expect([...refs].sort((a, b) => a - b)).toEqual(ir.templates.map((_: unknown, i: number) => i));
    const heads = [...out.html.matchAll(/<template id="sn-t-(\d+)"/g)].map((m) => +m[1]!);
    expect(heads.length).toBeGreaterThan(0);
    for (const h of heads) expect(h).toBeLessThan(ir.templates.length);
    // the early file renders the branch from its head template: the one the page module's anchor names
    expect(out.early).toBeTruthy();
    const branch = +/<template id="sn-t-(\d+)"><i>open<\/i><\/template>/.exec(out.html)![1]!;
    expect(ir.roots.flatMap((n: { b: unknown[] }) => n.b).find((b: { k: string }) => b.k === 'if').x).toBe(branch);
    expect(out.early).toContain(`, ${branch}, null,`);
    // (after the templates that went: numbered again)
    expect(branch).toBeLessThan(+/<template id="sn-t-(\d+)"><i>open<\/i><\/template>/.exec(dev.html)![1]!);
    // a loop's index name is its template's index
    ir.templates.forEach((t: { ii?: string }, i: number) => { if (t.ii) expect(t.ii).toBe(`$i${i}`); });
  });

  test('the page renders and updates as before', async () => {
    const { root, flush } = await render(PAGE.replace(/^<html><head><\/head><body>|<\/body><\/html>$/g, ''), { components: COMPONENTS, dev: false });
    const shape = () => root.querySelector('.doc')!.innerHTML.replace(/<!--[^>]*-->/g, '').replace(/ data-sn-c="[^"]*"/g, '');
    expect(shape()).toBe('<em title="e"><span>a</span><strong title="s"><span>b</span></strong></em>');
    expect(root.querySelector('i')!.textContent).toBe('open');
    const li = root.querySelector('li') as HTMLElement;
    expect([li.style.color, li.style.borderWidth, li.textContent]).toEqual(['red', '1px', 'red']);
    (root.querySelector('#clear') as HTMLElement).click();
    await flush();
    expect(shape()).toBe('');
    expect(root.querySelector('i')).toBe(null);
    const li2 = root.querySelector('li') as HTMLElement;
    expect([li2.style.color, li2.style.borderWidth, li2.textContent]).toEqual(['blue', '2px', 'blue']);
  });
});
