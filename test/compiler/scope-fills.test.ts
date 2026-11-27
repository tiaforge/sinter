// @vitest-environment node
// A component's `:scope` is its root. The slot content a component passes into another one's slots is its
// markup and gets its styles, so it is a scope root of the component's `@scope` (`data-sn-s="<name>"`) beside
// the root (`data-sn-c="<name>"`); `:scope` as written still names only the root (docs/components.md#styles).
// Each rule below sets a custom property of its own that does not inherit: what an element has is what matched it.
import { describe, expect, test } from 'vitest';
import { scopeCss } from '../../src/compiler/components.js';
import { compile } from '../../src/compiler/index.js';
import { chromium } from '../browser.js';

function run(page: string, files: Record<string, string>) {
  const all: Record<string, string> = {};
  for (const [k, v] of Object.entries(files)) all[`/p/src/components/${k}.html`] = v;
  return compile(page, { file: '/p/index.html', root: '/p', dev: false, helpers: { module: null, names: [], namespaces: {} }, readFile: (p) => { if (p in all) return all[p]!; throw new Error('missing'); } });
}

const SELS = [':scope', ':scope > *', ':scope span', 'span', '.k', '& > *', '.k:not(:scope)', ':is(:scope, .zz).k'];
const rules = (c: string) => SELS.map((s, i) => `@property --${c}${i} { syntax: '*'; inherits: false; }\n${s} { --${c}${i}: 1; }`).join('\n');
const comp = (c: string, markup: string, props = '') => `<template data-sn-props="${props}">${markup}</template>\n<style>${rules(c)}</style>`;

const FILES = {
  // default and named slots; the named one has default content (the component's own markup)
  'x-box': comp('box', '<div class="k" data-t="box"><span class="k" data-t="box-own">own</span><slot></slot><slot name="aside"><span class="k" data-t="box-default">default</span></slot></div>'),
  'x-inner': comp('inner', '<div class="k" data-t="inner"><span data-t="inner-own">i</span><slot></slot></div>'),
  // fills of its own into x-box: an element with a child, another, a nested component holding a fill of x-outer's
  'x-outer': comp('outer', '<div class="k" data-t="outer"><span data-t="outer-own">o</span><x-box><span class="k" data-t="outer-fill"><span data-t="outer-fill-child">c</span></span><b data-t="outer-fill2"><span data-t="outer-fill2-child">c</span></b><x-inner><span class="k" data-t="outer-into-inner">x</span></x-inner></x-box></div>'),
  // forwards what it is given into x-box, beside a fill of its own
  'x-pass': comp('pass', '<section class="k" data-t="pass"><x-box><span class="k" data-t="pass-fill">p</span><slot></slot></x-box></section>'),
  // inside itself, with a fill of its own into x-box at each level
  'x-tree': comp('tree', '<div class="k" data-t="tree"><x-box><span class="k" data-t="tree-fill"><span data-t="tree-fill-child">c</span></span></x-box><template data-sn-if="n > 0"><x-tree data-sn-with="{ n: n - 1 }"></x-tree></template></div>', '{ n: number }'),
};

const PAGE = `<!doctype html><html><head><title>t</title></head><body>
<x-box><span class="k" data-t="page-one"><span data-t="page-one-child">c</span></span></x-box>
<x-box><span class="k" data-t="page-a">a</span><span data-t="page-b">b</span>text<span slot="aside" class="k" data-t="page-aside">s</span></x-box>
<x-box>only text</x-box>
<x-outer></x-outer>
<x-tree data-sn-with="{ n: 1 }"></x-tree>
<x-pass><span class="k" data-t="page-into-pass"><span data-t="page-into-pass-child">c</span></span></x-pass>
</body></html>`;

// what matched each element: the rules of a component by their index in SELS (`outer1 2` is outer's rules 1 and 2)
const ROOT = '0 4 7', OWN = '1 2 3 4 5 6';
const BOX: Array<[string, string]> = [['box', `box${ROOT}`], ['box-own', `box${OWN}`]];
const EXPECTED: Array<[string, string]> = [
  // x-box filled by the page (one element; several, text and the named slot; text only): no rule of x-box's reaches the
  // page's content; the default content is x-box's own
  ...BOX, ['page-one', ''], ['page-one-child', ''], ['box-default', `box${OWN}`],
  ...BOX, ['page-a', ''], ['page-b', ''], ['page-aside', ''],
  ...BOX, ['box-default', `box${OWN}`],
  // x-outer's fills are its markup: its plain rules reach them (`span`, `.k`, `.k:not(:scope)`); `:scope` is its root only
  ['outer', `outer${ROOT}`], ['outer-own', 'outer1 2 3 5'], ...BOX,
  ['outer-fill', 'outer3 4 6'], ['outer-fill-child', 'outer3'], ['outer-fill2', ''], ['outer-fill2-child', 'outer3'],
  // a component in a fill: its root and markup are its own (nothing of x-outer's), the fill it holds is x-outer's
  ['inner', `inner${ROOT}`], ['inner-own', 'inner1 2 3 5'], ['outer-into-inner', 'outer3 4 6'],
  ['box-default', `box${OWN}`],
  // recursion: each level's fill is that level's markup; the inner level's root is not the outer level's `:scope`
  ['tree', `tree${ROOT}`], ...BOX, ['tree-fill', 'tree3 4 6'], ['tree-fill-child', 'tree3'], ['box-default', `box${OWN}`],
  ['tree', `tree${ROOT}`], ...BOX, ['tree-fill', 'tree3 4 6'], ['tree-fill-child', 'tree3'], ['box-default', `box${OWN}`],
  // forwarded: the page's content passed through x-pass into x-box is the page's, styled by neither
  ['pass', `pass${ROOT}`], ...BOX, ['pass-fill', 'pass3 4 6'], ['page-into-pass', ''], ['page-into-pass-child', ''], ['box-default', `box${OWN}`],
];

describe('a component\'s `:scope` and the slot content it passes on', () => {
  test('`:scope` and `&` are written against the root\'s mark, with the same specificity; the root copies of plain selectors are not', () => {
    const css = scopeCss(':scope { a: 1 }\n:scope > p, .k:not(:scope) { b: 1 }\n& > i { c: 1 }\n.k { d: 1 }\n@media (width > 1px) { :scope.x { e: 1 } }', 'x-a');
    expect(css).toBe(`@scope ([data-sn-c="x-a"], [data-sn-s="x-a"]) to ([data-sn-c], [data-sn-s]) {
:scope:where([data-sn-c="x-a"]){a:1}
:scope:where([data-sn-c="x-a"])>p,.k:not(:scope:where([data-sn-c="x-a"])){b:1}
:where(:scope:where([data-sn-c="x-a"]))>i{c:1}
.k,:where(:scope):is(.k){d:1}
@media (width > 1px){:scope:where([data-sn-c="x-a"]).x{e:1}}
}
`);
  });

  test('in Chromium: `:scope` matches the root only; a component\'s other rules reach the slot content it passes on, none reaches what is passed to it', async () => {
    const out = run(PAGE, FILES);
    expect(out.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    // the marks: fills by the markup that wrote them (the page's: `""`)
    expect(out.html).toContain('<span class="k" data-t="outer-fill" data-sn-s="x-outer">');
    expect(out.html).toContain('<span class="k" data-t="page-into-pass" data-sn-s="">');
    expect(out.html).toContain('<span class="k" data-t="tree-fill" data-sn-s="x-tree">');
    if (!chromium) return;
    const css = out.styles.map((s) => s.css).join('\n');
    const browser = await chromium.launch();
    try {
      const tab = await browser.newPage();
      await tab.setContent(out.html.replace(/<script[\s\S]*?<\/script>/g, '').replace('</head>', `<style>${css}</style></head>`));
      const got = await tab.evaluate((props) => {
        // the tree's inner level, as the runtime renders it: its definition's markup after its branch's marker
        const tree = document.querySelector('body > [data-t="tree"]')!;
        const def = [...document.querySelectorAll('template')].find((t) => t.content.firstElementChild?.getAttribute('data-t') === 'tree')!;
        const at = [...tree.childNodes].find((n) => n.nodeType === 8 && /^sn \d+$/.test(n.nodeValue!))!;
        tree.insertBefore(def.content.cloneNode(true), at.nextSibling);
        return [...document.body.querySelectorAll('[data-t]')].map((el) => {
          const s = getComputedStyle(el);
          const on = props.filter((p) => s.getPropertyValue(`--${p}`).trim() === '1');
          return [el.getAttribute('data-t')!, on.map((p, i) => (i ? p.replace(/^\D+/, '') : p)).join(' ')];
        });
      }, ['box', 'inner', 'outer', 'pass', 'tree'].flatMap((c) => SELS.map((_, i) => `${c}${i}`)));
      expect(got).toEqual(EXPECTED);
    } finally {
      await browser.close();
    }
  }, 60_000);
});
