// The canonicalizer (docs/proposals/redesign-notes/stage5-assembly.md, step 0): two results that differ only by
// numbering have one canonical form; a difference in a binding, a value, an attribute or a function body stays.
import { describe, expect, test } from 'vitest';
import { canonical, canonicalText, renameCode, renamePath } from '../../src/compiler/canon.js';
import type { CompiledParts } from '../../src/compiler/compile.js';
import { compile } from '../../src/compiler/index.js';

const names = new Map([['$s3', '$s0'], ['x$7', 'x$1'], ['$p7', '$p1'], ['$i7', '$i1']]);

describe('renameCode', () => {
  test('identifiers, members and keys are renamed; strings and templates are not', () => {
    expect(renameCode(`($) => ($.$s3.x + 'x$7' + \`US$2 \${$.x$7}\`)`, names)).toBe(`($) => ($.$s0.x + 'x$7' + \`US$2 \${$.x$1}\`)`);
    expect(renameCode(`($) => ({ $p7: $.$p7, "$s3": 1, [$.$i7]: 2 })`, names)).toBe(`($) => ({ $p1: $.$p1, "$s3": 1, [$.$i1]: 2 })`);
    expect(renameCode(`($) => { const { x$7 } = $; return { x$7 }; }`, names)).toBe(`($) => { const { x$7: x$1 } = $; return { x$7: x$1 }; }`);
  });
  test('a computed member with a string is the string', () => {
    expect(renameCode(`($) => ($["$s3"].x)`, names)).toBe(`($) => ($["$s3"].x)`);
  });
  test('`$.$d(N)` takes the id given; another call with a number does not', () => {
    expect(renameCode(`($) => ($.$d(4) + f(4) + $.$e(4))`, new Map(), new Map([[4, 0]]))).toBe(`($) => ($.$d(0) + f(4) + $.$e(4))`);
  });
  test('a name that only looks like one is not renamed', () => {
    expect(renameCode(`($) => ($.US$2 + $.x$70 + $.$s30)`, names)).toBe(`($) => ($.US$2 + $.x$70 + $.$s30)`);
  });
  test('paths, by segment', () => {
    expect(renamePath('$s3.x', names)).toBe('$s0.x');
    expect(renamePath('$r.list.{$i7}.x$7', names)).toBe('$r.list.{$i1}.x$1');
    expect(renamePath('$s30.x', names)).toBe('$s30.x');
  });
});

/** a page with a state, a loop with a renamed item, a nested loop, an if, and node ids; numbered by `n` */
function made(o: { t: [number, number, number]; s: number; ids: [number, number, number]; f: number[]; value?: string; attr?: string; kind?: 'text' | 'html'; body?: string }): CompiledParts {
  const [a, b, c] = o.t, [r0, r1, r2] = o.ids;
  const code: Record<string, string> = {
    state: `($) => ({ "q": (${o.value ?? "''"}) })`,
    list: `($) => ($.$r.items)`,
    name: `($) => ($.it$${a}.name + $.$s${o.s}.q)`,
    tags: `($) => ($.it$${a}.tags)`,
    tag: o.body ?? `($) => ($.t + $.$i${b})`,
    open: `($) => ($.$s${o.s}.q === 'x$1')`,
  };
  const keys = Object.keys(code);
  const fns: string[] = [];
  const at: Record<string, number> = {};
  o.f.forEach((k, j) => { fns[j] = code[keys[k]!]!; at[keys[k]!] = j; });
  const templates: Array<Record<string, unknown>> = [];
  templates[a] = { id: a, nodes: [{ tag: 'span', p: -1, b: [{ k: o.kind ?? 'text', f: at.name, d: [`$s${o.s}.q`] }], path: [0, 0] }, { tag: '#', p: -1, b: [{ k: 'for', f: at.tags, x: b }], path: [0, 1] }], item: `it$${a}`, index: null, ii: `$i${a}` };
  templates[b] = { id: b, nodes: [{ tag: 'i', p: -1, b: [{ k: 'text', f: at.tag }], path: [0] }], item: 't', index: null, ii: `$i${b}` };
  templates[c] = { id: c, nodes: [{ tag: 'p', p: -1, b: [], path: [0] }] };
  const heads = [[a, `<li><span></span><!--sn--><!--/sn--></li>`], [b, '<i></i>'], [c, '<p></p>']].sort((x, y) => (x[0] as number) - (y[0] as number));
  return {
    html: `<!DOCTYPE html><html><head></head><body><section data-sn="${r0}"${o.attr ?? ''}><ul><!--sn ${r1}--><!--/sn--></ul><!--sn ${r2}--><!--/sn--></section>${heads.map(([t, h]) => `<template id="sn-t-${t}">${h}</template>`).join('')}</body></html>`,
    ir: {
      v: 2, resources: [], syncs: [], actions: [],
      roots: [{ tag: 'section', p: -1, b: [], state: at.state, sid: o.s, id: r0 }, { tag: '#', p: 0, b: [{ k: 'for', f: at.list, d: ['$r.items'], x: a }], id: r1 }, { tag: '#', p: 0, b: [{ k: 'if', f: at.open, d: [`$s${o.s}.q`], x: c }], id: r2 }],
      templates,
    },
    fns, fixedState: [`$s${o.s}.q`],
  } as unknown as CompiledParts;
}

describe('canonical', () => {
  const base = { t: [0, 1, 2] as [number, number, number], s: 0, ids: [0, 1, 2] as [number, number, number], f: [0, 1, 2, 3, 4, 5] };
  const other = { t: [2, 0, 1] as [number, number, number], s: 5, ids: [3, 7, 9] as [number, number, number], f: [5, 3, 1, 0, 4, 2] };
  test('two results numbered otherwise are equal', () => {
    const x = made(base), y = made(other);
    expect(JSON.stringify(x)).not.toBe(JSON.stringify(y));
    expect(canonicalText(x)).toBe(canonicalText(y));
  });
  test('the canonical form of a result is itself canonical', () => {
    const c = canonical(made(other));
    expect(canonicalText(c)).toBe(canonicalText(made(other)));
    // and is numbered from the roots: the loop's template first, then its row's loop, then the branch
    expect(c.html).toContain('<template id="sn-t-0"><li>');
    expect(c.fns.join('\n')).toContain('$.it$0.name + $.$s0.q');
    expect(c.fns.join('\n')).toContain(`'x$1'`);
  });
  test('a different value, binding, attribute or body is not equal', () => {
    const y = canonicalText(made(other));
    expect(canonicalText(made({ ...base, value: "'a'" }))).not.toBe(y);
    expect(canonicalText(made({ ...base, kind: 'html' }))).not.toBe(y);
    expect(canonicalText(made({ ...base, attr: ' class="x"' }))).not.toBe(y);
    expect(canonicalText(made({ ...base, body: '($) => ($.t + $.$i1 + 1)' }))).not.toBe(y);
  });
  test('user text that reads like a generated name is untouched', () => {
    const c = canonical(made(other));
    expect(c.fns.find((f) => f.includes('===')) ).toBe(`($) => ($.$s0.q === 'x$1')`);
  });
});

describe('a real compile', () => {
  const files: Record<string, string> = { '/p/src/components/x-card.html': '<template data-sn-props="{ title: string; body: string }"><article><h3 data-sn-text="title"></h3><p data-sn-text="body"></p></article></template>' };
  const options = { file: '/p/index.html', root: '/p', dev: false, prerender: true, componentNames: ['x-card'], helpers: { module: null, names: [], namespaces: {} }, readFile: (f: string) => { if (f in files) return files[f]!; throw new Error(f); } };
  const page = `<!doctype html><html><head><title>t</title></head><body><sn-resource name="items" src="/api/items"></sn-resource><section data-sn-state="{ q: '', open: false }"><input data-sn-model="q"><button data-sn-on-click="open = !open">t</button><x-card data-sn-with="{ title: 'C', body: q }"></x-card><ul><template data-sn-for="it in items"><li><span data-sn-text="it.name"></span><template data-sn-for="t in it.tags"><i data-sn-text="t + q"></i></template></li></template></ul><template data-sn-if="open"><p data-sn-text="q"></p></template></section></body></html>`;
  test('canonical output is a valid compile with the same module up to numbering', () => {
    const plain = compile(page, options);
    process.env.SN_CANON = '1';
    let canon;
    try { canon = compile(page, options); } finally { delete process.env.SN_CANON; }
    // this page is numbered canonically already, but for its node ids (the card's folded `<h3>` leaves a gap)
    expect(canon.module).toBe(plain.module.replace(/"id":(\d+)/g, (m, d) => `"id":${+d > 3 ? +d - 1 : +d}`));
    expect(canon.html).toBe(plain.html.replace(/data-sn="(\d+)"|<!--sn (\d+)-->/g, (m, a, b) => (a !== undefined ? `data-sn="${+a > 3 ? +a - 1 : +a}"` : `<!--sn ${+b > 3 ? +b - 1 : +b}-->`)));
  });
});
