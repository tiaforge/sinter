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

  test('state nothing writes is as constant as a literal; state a handler, a model, a resource\'s then or the runtime writes stays bound', () => {
    const fixed = build('<div data-sn-state="{ nav: \'home\', open: false }"><a data-sn-class="{ active: nav == \'home\' }">Home</a><i data-sn-show="open"></i></div>');
    expect(fixed.html).toContain('<a class="active">Home</a>');
    expect(fixed.module).not.toContain("== 'home'");
    const kept = (body: string) => build(body).module;
    expect(kept('<div data-sn-state="{ nav: \'a\' }"><b data-sn-text="nav"></b><button data-sn-on-click="nav = \'b\'"></button></div>')).toContain('($) => ($.$s0.nav)');
    expect(kept('<div data-sn-state="{ q: \'a\' }"><b data-sn-text="q"></b><input data-sn-model="q"></div>')).toContain('($) => ($.$s0.q)');
    expect(kept('<div data-sn-state="{ g: true }"><sn-resource name="u" src="/api/u" then="g = !$result"></sn-resource><b data-sn-text="g"></b><i data-sn-text="u"></i></div>')).toContain('($) => ($.$s0.g)');
    expect(kept('<div data-sn-state="{ o: { a: 1 } }"><b data-sn-text="o.a"></b><button data-sn-on-click="o[\'a\'] = 2"></button></div>')).toContain('($) => ($.$s0.o.a)');
    expect(kept('<form data-sn-state="{ s: 1 }" data-sn-post="/x"><b data-sn-text="$error ? \'e\' : \'\'"></b></form>')).toContain('$error');
  });

  test('a component\'s script writes its root\'s state: what reads it stays bound', () => {
    const files: Record<string, string> = {
      '/p/src/components/x-clock.html': '<template data-sn-component=""><div data-sn-state="{ n: 0 }"><b data-sn-text="n"></b></div></template>',
      '/p/src/components/x-clock.ts': 'export class XClock {}',
    };
    const out = compile('<!doctype html><html><head></head><body><x-clock></x-clock></body></html>', {
      file: '/p/index.html', root: '/p', dev: false, prerender: true,
      helpers: { module: null, names: [], namespaces: {} }, readFile: (p) => { if (p in files) return files[p]!; throw new Error('missing'); },
    });
    expect(out.module).toContain('($) => ($.$s0.n)');
  });

  test('in a template, a dependency on state nothing writes is left out: the binding renders once per row or branch', () => {
    const out = build('<div data-sn-state="{ nav: \'home\', open: false }"><button data-sn-on-click="open = !open"></button><template data-sn-if="open"><a data-sn-class="{ active: nav == \'home\' && open }">x</a></template></div>');
    const ir = JSON.parse(/const ir = (\{.*\});/.exec(out.module)![1]!);
    const b = ir.templates[0].nodes[0].b[0];
    // `open` is written, `nav` is not: only `open` is a dependency
    const deps = JSON.stringify(b.d ?? []);
    expect(out.module).toContain("$.$s0.nav == 'home'");
    expect(deps).not.toBe('[]');
    expect(ir.ps.x['$s0.nav']).toBeUndefined();
  });

  test('in a template, a binding over state nothing writes is written into the template\'s markup', () => {
    const out = build('<div data-sn-state="{ nav: \'home\', open: false }"><button data-sn-on-click="open = !open"></button><template data-sn-if="open"><a data-sn-class="{ active: nav == \'home\' }">x</a><b data-sn-text="open"></b></template></div>');
    expect(out.html).toMatch(/<template data-sn="\d+"><a class="active">x<\/a><b><\/b><\/template>/);
    expect(out.module).not.toContain("== 'home'");
    // and `nav`, read by nothing else now, is out of the state
    expect(out.module).toContain('($) => ({ "open": (false) })');
    // in rows too, unless the binding reads the row
    const rows = build('<div data-sn-state="{ c: \'x\', list: [1, 2] }"><button data-sn-on-click="list = [3]"></button><template data-sn-for="i in list"><i data-sn-class="{ on: c == \'x\' }" data-sn-text="i"></i></template></div>');
    expect(rows.html).toContain('<i class="on"></i>');
    expect(rows.module).toContain('($) => ($.i)');
  });

  test('a data-sn-if over state nothing writes is decided at build time: its branch, or the else, is page markup', () => {
    const out = build(`<div data-sn-state="{ nav: 'home', n: 0 }"><button data-sn-on-click="n++"></button>
      <template data-sn-if="nav == 'home'"><p data-sn-text="n">home</p></template><template data-sn-else><p>other</p></template>
      <template data-sn-if="nav == 'login'"><i>login</i></template></div>`);
    expect(out.html).not.toContain('<template');
    expect(out.html).toMatch(/<p data-sn="\d+">0<\/p>/);
    expect(out.html).not.toContain('other');
    expect(out.html).not.toContain('login');
    expect(out.module).toContain('($) => ($.$s0.n)');
    // a written condition stays a template
    expect(build('<div data-sn-state="{ o: false }"><button data-sn-on-click="o = true"></button><template data-sn-if="o"><i>x</i></template></div>').html).toContain('<template');
  });

  test('a component used with different values: its data-sn-if stays, as the uses disagree', () => {
    const files: Record<string, string> = { '/p/src/components/x-tab.html': '<template data-sn-component="{ on: boolean }"><span><template data-sn-if="on"><b>on</b></template></span></template>' };
    const out = compile('<!doctype html><html><head></head><body><div data-sn-state="{ a: true, b: false }"><x-tab data-sn-prop="{ on: a }"></x-tab><x-tab data-sn-prop="{ on: b }"></x-tab></div></body></html>', {
      file: '/p/index.html', root: '/p', dev: false, prerender: true,
      helpers: { module: null, names: [], namespaces: {} }, readFile: (p) => { if (p in files) return files[p]!; throw new Error('missing'); },
    });
    expect(out.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    expect(out.html.match(/<template/g)?.length).toBe(2);
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
