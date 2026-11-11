// A `data-sn-for` over a constant list whose rows need nothing at run time is unrolled at build time:
// the rows are in the HTML, and the page module carries no template for them (docs/proposals/static-pages.md, step 1).
import { describe, expect, test } from 'vitest';
import { compile } from '../../src/compiler/index.js';

const options = (files: Record<string, string> = {}) => ({
  file: '/p/index.html', root: '/p', dev: false, prerender: true,
  helpers: { module: '/h.js', names: ['fmt'], namespaces: {} },
  readFile: (p: string) => { if (p in files) return files[p]!; throw new Error('missing'); },
});
const build = (body: string, files: Record<string, string> = {}) => compile(`<!doctype html><html><head></head><body>${body}</body></html>`, options(files));
const irOf = (module: string) => JSON.parse(/const ir = (\{.*\});/.exec(module)![1]!);
const bodyOf = (html: string) => /<body>([\s\S]*)<\/body>/.exec(html)![1]!;

const NAV = '<template data-sn-component="{ items: { href: string; label: string }[] }"><ul><template data-sn-for="(i, n) in items"><li><a data-sn-attr="{ href: i.href }" data-sn-text="(n + 1) + \'. \' + i.label"></a></li></template></ul></template>';
const LINKS = "[{ href: '/', label: 'Home' }, { href: '/about.html', label: 'About' }]";

describe('loops over constants', () => {
  test('a literal list: one row per item, written into the HTML, nothing in the page module', () => {
    const out = build(`<ul><template data-sn-for="i in ${LINKS}"><li><a data-sn-attr="{ href: i.href }" data-sn-text="i.label"></a></li></template></ul>`);
    expect(bodyOf(out.html)).toBe('<ul><li><a href="/">Home</a></li><li><a href="/about.html">About</a></li></ul>');
    const ir = irOf(out.module);
    expect(ir.roots).toEqual([]);
    expect(ir.templates).toEqual([]);
    expect(out.module).not.toContain('About');
  });

  test('a component\'s list prop given as a literal, with the index; two uses with different lists', () => {
    const files = { '/p/src/components/nav-list.html': NAV };
    const out = build(`<nav-list data-sn-prop="{ items: ${LINKS} }"></nav-list>\n<nav-list data-sn-prop="{ items: [{ href: '/x', label: 'X' }] }"></nav-list>`, files);
    expect(bodyOf(out.html)).toContain('<li><a href="/">1. Home</a></li><li><a href="/about.html">2. About</a></li>');
    expect(bodyOf(out.html)).toContain('<li><a href="/x">1. X</a></li>');
    expect(irOf(out.module).templates).toEqual([]);
    expect(out.diagnostics).toEqual([]);
  });

  test('state nothing writes is a constant list too; an empty list leaves nothing', () => {
    expect(bodyOf(build('<div data-sn-state="{ tags: [\'a\', \'b\'] }"><template data-sn-for="t in tags" data-sn-key="t"><b data-sn-text="t"></b></template></div>').html)).toContain('<b>a</b><b>b</b>');
    expect(bodyOf(build('<ul><template data-sn-for="t in []" data-sn-key="t"><li data-sn-text="t"></li></template></ul>').html)).toBe('<ul></ul>');
  });

  test('a row\'s static text and attributes are copied with it, and a row of several elements is copied whole', () => {
    const out = build('<dl><template data-sn-for="x in [{ k: \'a\', v: 1 }, { k: \'b\', v: 2 }]"><dt class="k" data-sn-text="x.k"></dt><dd>= <span data-sn-text="x.v"></span></dd></template></dl>');
    expect(bodyOf(out.html)).toBe('<dl><dt class="k">a</dt><dd>= <span>1</span></dd><dt class="k">b</dt><dd>= <span>2</span></dd></dl>');
  });

  test('stays a template: a list or a row that can change, a handler, a model, state or a nested template in a row', () => {
    const kept = (body: string) => irOf(build(body).module).templates.length;
    // the list is written
    expect(kept('<div data-sn-state="{ xs: [1] }"><template data-sn-for="x in xs" data-sn-key="x"><b data-sn-text="x"></b></template><button data-sn-on-click="xs = [2]"></button></div>')).toBe(1);
    // a row reads state that is written
    expect(kept('<div data-sn-state="{ q: 1 }"><template data-sn-for="x in [1, 2]" data-sn-key="x"><b data-sn-text="x + q"></b></template><button data-sn-on-click="q++"></button></div>')).toBe(1);
    // a row with a handler, a model, a state, a nested loop
    expect(kept('<div data-sn-state="{ s: 0 }"><template data-sn-for="x in [1, 2]" data-sn-key="x"><button data-sn-on-click="s = x"></button></template><b data-sn-text="s"></b></div>')).toBe(1);
    expect(kept('<template data-sn-for="x in [{ v: 1 }]"><div data-sn-state="{ o: 1 }"><b data-sn-text="o"></b></div></template>')).toBe(1);
    expect(kept('<template data-sn-for="x in [[1]]"><ul><template data-sn-for="y in x" data-sn-key="y"><li data-sn-text="y"></li></template></ul></template>')).toBe(2);
    // a list from a helper, the clock or data
    expect(kept('<template data-sn-for="x in fmt()" data-sn-key="x"><b data-sn-text="x"></b></template>')).toBe(1);
    expect(kept('<sn-resource name="xs" src="/api/xs"></sn-resource><template data-sn-for="x in xs" data-sn-key="x"><b data-sn-text="x"></b></template>')).toBe(1);
  });

  test('a page with an error is not unrolled (the second pass needs a clean first one)', () => {
    const out = build('<template data-sn-for="x in [1]" data-sn-key="x"><b data-sn-text="x"></b></template><p data-sn-text="nope"></p>');
    expect(out.diagnostics.some((d) => d.code === 'SN201')).toBe(true);
    expect(out.html).toContain('<template');
  });
});

describe('loops over constants, with components in the rows', () => {
  test('a row that is a component: its props read the item', () => {
    const files = {
      '/p/src/components/nav-item.html': '<template data-sn-component="{ link: { href: string; label: string } }"><li><a data-sn-attr="{ href: link.href }" data-sn-text="link.label"></a></li></template>',
    };
    const out = build(`<ul><template data-sn-for="i in ${LINKS}"><nav-item data-sn-prop="{ link: i }"></nav-item></template></ul>`, files);
    expect(out.diagnostics).toEqual([]);
    expect(bodyOf(out.html)).toBe('<ul><li><a href="/">Home</a></li><li><a href="/about.html">About</a></li></ul>');
    expect(irOf(out.module).templates).toEqual([]);
  });

  test('a component inside a row, below its top element', () => {
    const files = { '/p/src/components/x-label.html': '<template data-sn-component="{ text: string }"><b data-sn-text="text"></b></template>' };
    const out = build(`<ul><template data-sn-for="i in ${LINKS}"><li><x-label data-sn-prop="{ text: i.label }"></x-label></li></template></ul>`, files);
    expect(out.diagnostics).toEqual([]);
    expect(bodyOf(out.html)).toBe('<ul><li><b>Home</b></li><li><b>About</b></li></ul>');
  });
});
