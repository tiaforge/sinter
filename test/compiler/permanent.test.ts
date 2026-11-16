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

  test('a name; one element of the page; nothing inside that binds', () => {
    expect(problems(build('<aside data-sn-permanent="1 player"></aside>'))).toEqual(['SN346 `data-sn-permanent` takes a name (letters, digits, `-` and `_`), the same on each page that keeps the element']);
    expect(problems(build('<div data-sn-state="{ xs: [1] }"><template data-sn-for="x in xs"><aside data-sn-permanent="p"></aside></template></div>'))).toContain('SN346 `data-sn-permanent` cannot be inside a `<template>`: a kept element is one element of the page');
    expect(problems(build('<div data-sn-state="{ s: 1 }"><aside data-sn-permanent="p"><b data-sn-text="s"></b></aside></div>'))).toEqual(['SN346 a kept element holds no bindings (`data-sn-text`): the next page\'s code would not find it']);
    expect(problems(build('<aside data-sn-permanent="p" data-sn-state="{ s: 1 }"></aside>'))).toEqual(['SN346 a kept element holds no bindings (`data-sn-state`): the next page\'s code would not find it']);
    expect(problems(build('<aside data-sn-permanent="p"></aside><nav data-sn-permanent="p"></nav>'))).toEqual(['SN346 `data-sn-permanent="p"` is on two elements of this page']);
    expect(build('<aside data-sn-permanent="a"></aside><nav data-sn-permanent="b-2"></nav>').permanent).toEqual(['a', 'b-2']);
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
  test('none with swaps off, or on a page that opts out', () => {
    expect(build(body).diagnostics).toEqual([]);
    expect(build(body, { swap: true }, '<html data-sn-swap="off">').diagnostics).toEqual([]);
  });
});

test('data-sn-swap on a layout\'s tag goes onto <html>, as data-sn-prefetch does', () => {
  const layout = '<!doctype html><html data-sn-layout=""><head><title>x</title></head><body><slot></slot></body></html>';
  const out = compile('<site-layout data-sn-swap="off"><p>Hi.</p></site-layout>', {
    file: '/p/about.html', root: '/p', dev: false, prerender: true, moduleSrc: '/@sinter/about.html.js',
    helpers: { module: null, names: [], namespaces: {} },
    readFile: (p: string) => { if (p === '/p/src/layouts/site-layout.html') return layout; throw new Error('missing'); },
  });
  expect(out.diagnostics).toEqual([]);
  expect(out.swapOff).toBe(true);
});
