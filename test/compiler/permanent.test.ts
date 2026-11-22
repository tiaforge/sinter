// Kept elements and the swap's opt-outs, as the build sees them (docs/proposals/swap-navigation.md, step 3):
// `data-sn-permanent` names one element of the page that holds no bindings, `data-sn-swap="off"` a page or
// a link the swap leaves to the browser. Both markers stay in the HTML, for the runtime.
import { describe, expect, test } from 'vitest';
import { compile } from '../../src/compiler/index.js';

const build = (body: string, more: Record<string, unknown> = {}, html = '<html>') => compile(`<!doctype html>${html}<head><title>x</title></head><body>${body}</body></html>`, {
  file: '/p/about.html', root: '/p', dev: false, prerender: true, moduleSrc: '/@sinter/about.html.js',
  helpers: { module: null, names: [], namespaces: {} }, readFile: () => { throw new Error('missing'); }, ...more,
});
const problems = (out: ReturnType<typeof build>) => out.diagnostics.map((d) => `${d.code} ${d.message}`);

describe('data-sn-permanent', () => {
  test('with swaps on, a reason to ship the module, where it was written; the marker stays', () => {
    const out = build('<p>Hi.</p>\n<aside data-sn-permanent="player"><audio controls></audio></aside>', { swap: true });
    expect(out.static).toBeUndefined();
    expect(out.runtime.map((r) => `${r.what} ${r.file.replace('/p/', '')}:${r.line}`)).toEqual(['`data-sn-permanent` (links swap the next page in around it) about.html:2']);
    expect(out.html).toContain('<aside data-sn-permanent="player">');
    expect(out.permanent).toEqual(['player']);
  });

  test('with swaps off (the default), no reason: a page with nothing else to run stays without JavaScript', () => {
    const out = build('<aside data-sn-permanent="player"><audio controls></audio></aside>');
    expect(out.static).toBe(true);
    expect(out.runtime).toEqual([]);
    expect(out.diagnostics).toEqual([]);
    expect(out.html).toContain('<aside data-sn-permanent="player">');
  });

  test('SN322 on a page that must ship none, with swaps on', () => {
    const out = build('<aside data-sn-permanent="player"></aside>', { static: true, swap: true });
    expect(out.diagnostics.filter((x) => x.code === 'SN322').map((x) => x.message)).toEqual([
      'about.html must ship no JavaScript (`sinter({ static })`), but `data-sn-permanent` (links swap the next page in around it) runs in the browser',
    ]);
  });

  test('a name; one element of the page; two names whose ranges clash', () => {
    expect(problems(build('<aside data-sn-permanent="1 player"></aside>'))).toEqual(['SN346 `data-sn-permanent` takes a name (letters, digits, `-` and `_`), the same on each page that keeps the element']);
    expect(problems(build('<div data-sn-state="{ xs: [1] }"><template data-sn-for="x in xs" data-sn-key="x"><aside data-sn-permanent="p"></aside></template></div>'))).toContain('SN346 `data-sn-permanent` cannot be inside a `<template>`: a kept element is one element of the page');
    expect(problems(build('<aside data-sn-permanent="p"></aside><nav data-sn-permanent="p"></nav>'))).toEqual(['SN346 `data-sn-permanent="p"` is on two elements of this page']);
    expect(problems(build('<aside data-sn-permanent="k23"></aside><nav data-sn-permanent="k38"></nav>'))).toEqual(['SN346 `k38` and `k23` get the same range of ids: rename one']);
    expect(build('<aside data-sn-permanent="a"></aside><nav data-sn-permanent="b-2"></nav>').permanent).toEqual(['a', 'b-2']);
  });

  test('a kept element binds: its nodes numbered in a range of its own, the same on every page; the page\'s go on', () => {
    const body = (before: string) => `${before}<aside data-sn-permanent="player" data-sn-state="{ open: false }"><button data-sn-on-click="open = !open">t</button><p data-sn-show="open">x</p></aside><i data-sn-text="$url.q"></i>`;
    const one = build(body('<b data-sn-text="$url.a"></b>')), two = build(body('<b data-sn-text="$url.a"></b><b data-sn-text="$url.b"></b><b data-sn-text="$url.c"></b>'));
    expect(one.diagnostics).toEqual([]);
    const ids = (out: ReturnType<typeof build>) => [.../data-sn-permanent="player"[^>]*>([\s\S]*?)<\/aside>/.exec(out.html)![0]!.matchAll(/data-sn="(\d+)"/g)].map((m) => +m[1]!);
    expect(ids(one)).toEqual(ids(two));
    expect(ids(one)[0]).toBeGreaterThanOrEqual(1_000_000);
    // the page's own numbering goes on after it
    expect(/<i data-sn="(\d+)"/.exec(one.html)![1]).toBe('1');
    expect(one.keptBound).toEqual(['player']);
    expect(Object.keys(one.keptSource!)).toEqual(['player']);
  });

  test('SN541: media inside whose playback is bound', () => {
    const out = build('<aside data-sn-permanent="p" data-sn-state="{ m: false, s: \'/a.wav\' }"><audio data-sn-attr="{ src: s, muted: m }"></audio></aside>');
    expect(out.diagnostics.map((d) => `${d.severity} ${d.code} ${d.message}`)).toEqual([
      'warning SN541 `muted` of a `<audio>` in a kept element is bound: the next page\'s code sets it again when a link swaps it in, which interrupts playback',
    ]);
  });
});

describe('data-sn-swap', () => {
  test('off on <html>: recorded for the build; on a link: kept for the runtime', () => {
    const page = build('<a href="/x" data-sn-swap="off">x</a>', {}, '<html data-sn-swap="off">');
    expect(page.diagnostics).toEqual([]);
    expect(page.swapOff).toBe(true);
    expect(page.html).toContain('<a href="/x" data-sn-swap="off">');
    expect(build('<a href="/x" data-sn-swap="off">x</a>').swapOff).toBeUndefined();
  });

  test('only `off`, only on <html> or a link', () => {
    expect(problems(build('<a href="/x" data-sn-swap="on">x</a>'))).toEqual(['SN401 `data-sn-swap` takes `off`; with `sinter({ swap: true })` links swap without the attribute']);
    expect(problems(build('<div data-sn-swap="off"></div>'))).toEqual(['SN102 `data-sn-swap` belongs on `<html>` (links to the page load it) or on a link (it loads its page)']);
  });
});

describe('SN540: a script a swap would not run', () => {
  const body = '<script>track()</script><script src="/legacy.js"></script><script type="module" src="/m.js"></script><script type="application/ld+json">{}</script>';
  test('with swaps on: inline and classic scripts in the body, each named', () => {
    expect(build(body, { swap: true }).diagnostics.map((d) => `${d.severity} ${d.code} ${d.message}`)).toEqual([
      'warning SN540 an inline script in the body does not run when a link swaps this page in (`sinter({ swap: true })`), only on a page load',
      'warning SN540 a classic script (`/legacy.js`) in the body does not run when a link swaps this page in (`sinter({ swap: true })`), only on a page load',
    ]);
  });
  test('only what the browser runs: no type, a JavaScript MIME type, a module; not data (`text/plain`, a template\'s text)', () => {
    const codes = (b: string) => build(b, { swap: true }).diagnostics.filter((d) => d.code === 'SN540').length;
    for (const t of ['text/javascript', 'Application/JavaScript', 'text/ecmascript', 'application/x-javascript', 'text/javascript1.5', 'text/jscript', ' module ']) expect(codes(`<script type="${t}">x()</script>`), t).toBe(1);
    for (const t of ['text/plain', 'text/x-template', 'application/json', 'importmap', 'speculationrules', 'text/javascript; charset=utf-8', 'text/markdown']) expect(codes(`<script type="${t}">x</script>`), t).toBe(0);
  });
  test('none with swaps off, or on a page that opts out', () => {
    expect(build(body).diagnostics).toEqual([]);
    expect(build(body, { swap: true }, '<html data-sn-swap="off">').diagnostics).toEqual([]);
  });
});

test('data-sn-swap on a layout\'s tag goes onto <html>, as data-sn-prefetch does', () => {
  const layout = '<!doctype html><html data-sn-props=""><head><title>x</title></head><body><slot></slot></body></html>';
  const out = compile('<site-layout data-sn-swap="off"><p>Hi.</p></site-layout>', {
    file: '/p/about.html', root: '/p', dev: false, prerender: true, moduleSrc: '/@sinter/about.html.js',
    helpers: { module: null, names: [], namespaces: {} },
    readFile: (p: string) => { if (p === '/p/src/layouts/site-layout.html') return layout; throw new Error('missing'); },
  });
  expect(out.diagnostics).toEqual([]);
  expect(out.swapOff).toBe(true);
});

test('SN346: a kept element inside another', () => {
  expect(problems(build('<div data-sn-permanent="outer"><aside data-sn-permanent="inner"></aside></div>'))).toEqual(['SN346 `data-sn-permanent` cannot be inside another kept element: the outer one is kept with everything in it']);
});

test('with swaps on, constant props do not shape a kept element: the same ids and bindings on every page, whatever each passes', () => {
  const layout = `<!doctype html><html data-sn-props="{ title: string; fancy: boolean }"><head><title data-sn-text="title"></title></head><body>
<aside data-sn-permanent="p" data-sn-state="{ n: 0 }"><a href="/k1/" data-sn-class="{ active: title == 'K1' }">K1</a><template data-sn-if="fancy"><em data-sn-text="'fancy ' + n"></em></template><b data-sn-text="title + ' ' + n"></b><button data-sn-on-click="n = n + 1">+</button></aside>
<main><slot></slot></main></body></html>`;
  const page = (props: string, swap: boolean) => compile(`<site-layout data-sn-with="${props}"><p>x</p></site-layout>`, {
    file: '/p/k.html', root: '/p', dev: false, prerender: true, moduleSrc: '/@sinter/k.html.js', swap,
    helpers: { module: null, names: [], namespaces: {} },
    readFile: (p: string) => { if (p === '/p/src/layouts/site-layout.html') return layout; throw new Error('missing'); },
  });
  const kept = (html: string) => /<aside[^>]*data-sn-permanent="p"[^>]*>[\s\S]*?<\/aside>/.exec(html)![0]!;
  const shape = (html: string) => [...kept(html).matchAll(/<(\w+)[^>]*data-sn="(\d+)"|<!--sn (\d+)-->/g)].map((m) => (m[3] ? `anchor ${m[3]}` : `${m[1]} ${m[2]}`));
  const k1 = page("{ title: 'K1', fancy: true }", true), k2 = page("{ title: 'K2', fancy: false }", true);
  expect(k1.diagnostics).toEqual([]);
  expect(shape(k1.html)).toEqual(shape(k2.html));
  // the branch stays a branch, the class and the text stay bound
  expect(shape(k1.html).some((x) => x.startsWith('anchor'))).toBe(true);
  expect(shape(k1.html).filter((x) => /^(a|b) /.test(x))).toHaveLength(2);
  // without swaps the constants fold as before: k2's branch is decided, and the shapes differ
  expect(shape(page("{ title: 'K1', fancy: true }", false).html)).not.toEqual(shape(page("{ title: 'K2', fancy: false }", false).html));
});

describe('with swaps on, what each page passes does not shape a kept element (the third review)', () => {
  const files: Record<string, string> = {
    // a component used inside the kept element, its branch on a constant the layout passes on
    '/p/src/components/my-badge.html': `<template data-sn-props="{ fancy: boolean }"><span data-sn-state="{ n: 0 }"><template data-sn-if="fancy"><em data-sn-text="'x ' + n"></em></template><u data-sn-text="n"></u><b tabindex="0" data-sn-on-click="n = n + 1">+</b></span></template>`,
    // a component whose root is the kept element
    '/p/src/components/kept-bar.html': `<template data-sn-props="{ fancy: boolean }"><aside data-sn-permanent="bar" data-sn-state="{ n: 0 }"><template data-sn-if="fancy"><em data-sn-text="'x ' + n"></em></template><u data-sn-text="n"></u></aside></template>`,
    '/p/src/layouts/site-layout.html': `<!doctype html><html data-sn-props="{ fancy: boolean; title: string }"><head><title data-sn-text="title"></title></head><body>
<aside data-sn-permanent="p"><my-badge data-sn-with="{ fancy }"></my-badge></aside><kept-bar data-sn-with="{ fancy }"></kept-bar><main><slot></slot></main></body></html>`,
  };
  const page = (props: string) => compile(`<site-layout data-sn-with="${props}"><p>x</p></site-layout>`, {
    file: '/p/k.html', root: '/p', dev: false, prerender: true, moduleSrc: '/@sinter/k.html.js', swap: true,
    helpers: { module: null, names: [], namespaces: {} }, readFile: (p: string) => { if (p in files) return files[p]!; throw new Error('missing'); },
  });
  const shape = (html: string, name: string) => [...new RegExp(`<aside[^>]*data-sn-permanent="${name}"[^>]*>[\\s\\S]*?</aside>`).exec(html)![0]!.matchAll(/<(\w+)[^>]*data-sn="(\d+)"|<!--sn (\d+)-->/g)].map((m) => (m[3] ? `anchor ${m[3]}` : `${m[1]} ${m[2]}`));

  test('a component inside one, and one whose root is one', () => {
    const a = page("{ fancy: true, title: 'A' }"), b = page("{ fancy: false, title: 'B' }");
    expect(a.diagnostics).toEqual([]);
    for (const name of ['p', 'bar']) {
      expect(shape(a.html, name)).toEqual(shape(b.html, name));
      expect(shape(a.html, name).some((x) => x.startsWith('anchor'))).toBe(true);
    }
  });

  test('SN346: a slot in a kept element that binds; the document\'s own elements', () => {
    const layout = '<!doctype html><html data-sn-props="{ title: string }"><head><title>x</title></head><body><aside data-sn-permanent="side"><slot name="side"></slot><b data-sn-text="title"></b></aside><main><slot></slot></main></body></html>';
    const out = compile('<site-layout data-sn-with="{ title: \'A\' }"><i slot="side" data-sn-text="$url.q"></i><p>x</p></site-layout>', {
      file: '/p/k.html', root: '/p', dev: false, prerender: true, moduleSrc: '/m.js', swap: true, helpers: { module: null, names: [], namespaces: {} },
      readFile: (p: string) => { if (p === '/p/src/layouts/site-layout.html') return layout; throw new Error('missing'); },
    });
    expect(out.diagnostics.map((d) => d.message.replace(/ \(included from .*\)$/, ''))).toEqual(['a kept element that binds holds a `<slot>` (`side`): each page fills it with its own content, so the next page\'s code would not find its nodes']);
    const body = compile('<!doctype html><html><head><title>x</title></head><body data-sn-permanent="all"><p>x</p></body></html>', { file: '/p/a.html', root: '/p', dev: false, moduleSrc: '/m.js', swap: true, helpers: { module: null, names: [], namespaces: {} }, readFile: () => '' });
    expect(body.diagnostics.map((d) => `${d.code} ${d.message}`)).toEqual(['SN346 `data-sn-permanent` belongs on an element of the body: `<body>` is the page\'s own']);
  });

  test('nesting, with swaps on', () => {
    expect(problems(build('<div data-sn-permanent="outer"><aside data-sn-permanent="inner"></aside></div>', { swap: true }))).toEqual(['SN346 `data-sn-permanent` cannot be inside another kept element: the outer one is kept with everything in it']);
  });
});

test('SN209: `sn-…` names are sinter\'s events, so a component cannot emit one; `navigate` is the component\'s own now', () => {
  const files: Record<string, string> = { '/p/src/components/nav-pick.html': '<template data-sn-props="{}" data-sn-emits="{ \'sn-navigate\': string }"><button>x</button></template>' };
  const out = compile('<!doctype html><html><head><title>x</title></head><body><nav-pick></nav-pick></body></html>', {
    file: '/p/a.html', root: '/p', dev: false, moduleSrc: '/m.js', helpers: { module: null, names: [], namespaces: {} },
    readFile: (p: string) => { if (p in files) return files[p]!; throw new Error('missing'); },
  });
  expect(out.diagnostics.filter((d) => d.code === 'SN209').map((d) => d.message.replace(/ \(included from .*\)$| … used at .*$/, ''))).toEqual([
    "`sn-navigate`: names starting with `sn-` are sinter's events (`sn-navigate`, `sn-dismiss`, `sn-error`, `sn-page`); name the component's event otherwise",
  ]);
});
