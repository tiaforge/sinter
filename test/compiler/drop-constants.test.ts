// A binding the build wrote into the HTML that reads nothing can never change: the page module leaves
// it out (its function, and its node when nothing else is bound there).
import { describe, expect, test } from 'vitest';
import { compile } from '../../src/compiler/index.js';

const build = (body: string, head = '') => compile(`<!doctype html><html><head>${head}</head><body>${body}</body></html>`, {
  file: '/p/index.html', root: '/p', dev: false, prerender: true,
  helpers: { module: '/h.js', names: ['fmt'], namespaces: {} }, readFile: () => { throw new Error('missing'); },
});

describe('constant bindings', () => {
  test('a constant is in the HTML only: no data-sn, no node, no function', () => {
    const out = build('<p data-sn-text="\'Hello\' + \' world\'"></p>', '<title data-sn-text="\'Sign in\' + \' — Conduit\'">x</title>');
    expect(out.html).toContain('<title>Sign in — Conduit</title>');
    expect(out.html).toContain('<p>Hello world</p>');
    expect(out.html).not.toContain('data-sn=');
    expect(out.module).not.toContain('Conduit');
    expect(out.module).not.toContain('world');
    expect(out.module).toContain('"roots":[]');
  });

  test('a value from state stays bound: a handler can change it', () => {
    const out = build('<div data-sn-state="{ n: 0 }"><p data-sn-text="n"></p><button data-sn-on-click="n++">+</button></div>');
    expect(out.html).toMatch(/<p data-sn="\d+">0<\/p>/);
    expect(out.module).toContain('($) => ($.$s0.n)');
  });

  test('a node keeps its other bindings; the roots after a dropped one are renumbered', () => {
    const out = build(`<p data-sn-text="'a'"></p>
      <div data-sn-state="{ q: '' }"><sn-resource name="r" src="/api/r?q={q}"></sn-resource><input data-sn-model="q"><i data-sn-text="'b'" data-sn-class="{ on: q }"></i><b data-sn-text="r"></b></div>`);
    const ir = JSON.parse(/const ir = (\{.*\});/.exec(out.module)![1]!);
    // the state's node is now the first: the resource's scope and the children's parent follow it
    expect(ir.roots[0].tag).toBe('div');
    expect(ir.resources[0].scope ?? -1).toBe(0);
    expect(ir.roots.slice(1).every((n: { p?: number }) => n.p === 0)).toBe(true);
    // `<i>`: the text was constant, the class is not
    const i = ir.roots.find((n: { tag: string }) => n.tag === 'i');
    expect(i.b.map((b: { k: string }) => b.k)).toEqual(['class']);
    expect(out.html).toMatch(/<i data-sn="\d+">b<\/i>/);
  });

  test('a helper\'s value is not a constant, and a function another binding uses stays', () => {
    const out = build('<p data-sn-text="fmt(1)"></p><p data-sn-text="\'x\'"></p><div data-sn-state="{ k: 1 }"><span data-sn-attr="{ title: \'x\' }" data-sn-text="k"></span></div>');
    expect(out.module).toContain('fmt(1)');
    expect(out.html).toContain('<p>x</p>');
  });
});
