// The component root (docs/proposals/component-libraries.md, section 3): a root renders at most one
// element: a plain element, an if/else chain of roots, a component tag, `<sn-component use>`, or a
// `<slot>` whose default and fills are roots.
import { describe, expect, test } from 'vitest';
import { compile } from '../../src/compiler/index.js';

function run(page: string, files: Record<string, string>, o: { dev?: boolean; prerender?: boolean } = {}) {
  const all: Record<string, string> = {};
  for (const [k, v] of Object.entries(files)) all[`/p/src/${k.includes('/') ? k : `components/${k}.html`}`] = v;
  return compile(page, { file: '/p/index.html', root: '/p', dev: !!o.dev, ...(o.prerender ? { prerender: true } : {}), helpers: { module: null, names: [], namespaces: {} }, readFile: (p) => { if (p in all) return all[p]!; throw new Error('missing'); } });
}
const errors = (out: ReturnType<typeof run>) => out.diagnostics.filter((d) => d.severity === 'error').map((d) => `${d.code} ${d.message}`);
const body = (out: ReturnType<typeof run>) => /<body>([\s\S]*)<\/body>/.exec(out.html)![1]!.replace(/\s+/g, ' ').trim();
const head = (out: ReturnType<typeof run>) => /<head>([\s\S]*)<\/head>/.exec(out.html)![1]!.replace(/\s+/g, ' ').trim();

const BUTTON = `<template data-sn-props="{ href?: string; label: string }">
  <template data-sn-if="href"><a data-sn-attr="{ href }" data-sn-text="label"></a></template>
  <template data-sn-else><button type="button" data-sn-text="label"></button></template>
</template>`;
const PRIMARY = `<template data-sn-props="{ href?: string; label: string }">
  <ui-button class="primary" data-sn-prop="{ href, label }"></ui-button>
</template>`;

describe('an if/else chain as root', () => {
  test('a button that is a link or a button: the tag\'s attributes land on each branch', () => {
    const out = run(`<div data-sn-state="{ to: '/x', n: 0 }"><ui-button class="big" title="go" data-sn-prop="{ href: to, label: 'Go' }" data-sn-on-click="n++"></ui-button></div>`, { 'ui-button': BUTTON });
    expect(errors(out)).toEqual([]);
    expect(out.html).toMatch(/<template id="sn-t-\d+"><a class="big" title="go"><\/a><\/template><template id="sn-t-\d+"><button type="button" class="big" title="go"><\/button><\/template>/);
    expect(body(out)).toMatch(/^<div data-sn="\d+"><!--sn \d+--><!--\/sn--><\/div>/);
    // the handler, in the caller's scope, on each branch
    expect(out.module.match(/\$\.\$s0\.n\+\+/g)).toHaveLength(1);
    expect(out.module).toContain('($) => ($.$s0.to)');
  });

  test('a constant prop decides the root at build time: only the element is left', () => {
    const out = run(`<ui-button class="big" data-sn-prop="{ label: 'Go' }"></ui-button>`, { 'ui-button': BUTTON });
    expect(errors(out)).toEqual([]);
    expect(body(out)).toBe('<button type="button" class="big" data-sn="0"></button>');
  });
});

describe('a component tag as root', () => {
  test('a variant with no wrapper: classes join down to the element that renders', () => {
    const out = run(`<primary-button class="wide" data-sn-prop="{ label: 'Save' }"></primary-button>`, { 'ui-button': BUTTON, 'primary-button': PRIMARY });
    expect(errors(out)).toEqual([]);
    expect(out.html).toMatch(/<template id="sn-t-\d+"><a class="primary wide"><\/a><\/template><template id="sn-t-\d+"><button type="button" class="primary wide"><\/button><\/template>/);
    // its own condition reads the outer component's prop: the caller's left-out `href`
    expect(out.module).toContain('($) => (undefined)');
  });
});

describe('the tag\'s attributes', () => {
  test('through a component tag as root: the outer tag\'s handler is compiled in its caller\'s scope, on each branch', () => {
    const out = run(`<div data-sn-state="{ n: 0 }"><primary-button data-sn-on-click="n = n + 2" data-sn-prop="{ label: 'Save' }"></primary-button></div>`, { 'ui-button': BUTTON, 'primary-button': PRIMARY });
    expect(errors(out)).toEqual([]);
    expect(out.module).toContain('$.$s0.n = $.$s0.n + 2');
    expect(out.module.match(/"k":"on"/g)).toHaveLength(2);
  });

  test('one attribute on the tag and on a branch\'s element: SN209, per branch', () => {
    const C = '<template data-sn-props="{ on?: boolean }"><template data-sn-if="on"><a title="a"></a></template><template data-sn-else><b></b></template></template>';
    expect(errors(run('<div data-sn-state="{ v: 1 }"><x-c title="t" data-sn-prop="{ on: v }"></x-c></div>', { 'x-c': C }))).toEqual([expect.stringMatching(/^SN209 `title` is set both here and on the root of `<x-c>`/)]);
  });

  test('a `<slot>` as root: the tag\'s attributes land on the fill, or on the default; a conflict names the fill', () => {
    const C = '<template data-sn-props=""><slot><span class="dflt"></span></slot></template>';
    const filled = run('<div data-sn-state="{ n: 1 }"><x-c class="mine"><em data-sn-text="n"></em></x-c></div>', { 'x-c': C });
    expect(errors(filled)).toEqual([]);
    expect(body(filled)).toBe('<div data-sn="0"><em class="mine" data-sn="1"></em></div>');
    expect(body(run('<x-c class="mine"></x-c>', { 'x-c': C }))).toBe('<span class="dflt mine"></span>');
    expect(errors(run('<x-c title="a"><em title="b"></em></x-c>', { 'x-c': C }))).toEqual([expect.stringMatching(/^SN209 `title` is set both here and on `<em>`, the fill of `<x-c>`'s `<slot>` that is its root/)]);
    // a fill that is two elements is no root
    expect(errors(run('<x-c><em></em><em></em></x-c>', { 'x-c': C }))).toEqual([expect.stringMatching(/^SN312 a component's root renders at most one element; `<x-c>` has 2 elements/)]);
  });

  test('a root that may render nothing takes no id, model, action or transition on its tag: SN334, also through a component tag', () => {
    const MAYBE = '<template data-sn-props="{ on?: boolean }"><template data-sn-if="on"><p></p></template></template>';
    const OUTER = '<template data-sn-props="{ on?: boolean }"><x-maybe data-sn-prop="{ on }"></x-maybe></template>';
    const page = (a: string) => `<div data-sn-state="{ v: true }"><x-outer ${a} data-sn-prop="{ on: v }"></x-outer></div>`;
    for (const a of ['id="o"', 'data-sn-post="/x"', 'data-sn-transition="fade"']) {
      expect(errors(run(page(a), { 'x-maybe': MAYBE, 'x-outer': OUTER }))).toContainEqual(expect.stringMatching(/^SN334 `<x-outer>`'s root may render nothing \(through `<x-maybe>`\)/));
    }
    expect(errors(run(page('class="c"'), { 'x-maybe': MAYBE, 'x-outer': OUTER }))).toEqual([]);
    // decided to render nothing for this use: nothing is left
    expect(body(run('<x-maybe></x-maybe>', { 'x-maybe': MAYBE }))).toBe('');
  });
});

describe('what keeps a plain root', () => {
  test('a script, or data-sn-state on the root', () => {
    const CHAIN = (state = '') => `<template data-sn-props="{ on?: boolean }"><template data-sn-if="on"><a${state}></a></template><template data-sn-else><b></b></template></template>`;
    expect(errors(run('<div data-sn-state="{ v: 1 }"><x-s data-sn-prop="{ on: v }"></x-s></div>', { 'x-s': CHAIN(), 'components/x-s.ts': 'export class XS {}' })))
      .toEqual([expect.stringMatching(/^SN312 `<x-s>` has a script \(`\/src\/components\/x-s.ts`\), so its root is one plain element/)]);
    expect(errors(run('<div data-sn-state="{ v: 1 }"><x-s data-sn-prop="{ on: v }"></x-s></div>', { 'x-s': CHAIN(' data-sn-state="{ open: false }"') })))
      .toEqual([expect.stringMatching(/^SN312 `<x-s>` has `data-sn-state` on its root, so its root is one plain element/)]);
  });
});

describe('roots that are no element', () => {
  test('text, a loop, several elements: SN312', () => {
    expect(errors(run('<x-t></x-t>', { 'x-t': '<template data-sn-props="">hi</template>' }))).toEqual([expect.stringMatching(/^SN312 a component's root renders at most one element; `<x-t>` has text/)]);
    expect(errors(run('<x-t></x-t>', { 'x-t': '<template data-sn-props=""><template data-sn-for="x in [1]"><p></p></template></template>' }))).toEqual([expect.stringMatching(/^SN312 .*`<template data-sn-for>` cannot be the root of `<x-t>`/)]);
    expect(errors(run('<div data-sn-state="{ v: 1 }"><x-t data-sn-prop="{ on: v }"></x-t></div>', { 'x-t': '<template data-sn-props="{ on?: boolean }"><template data-sn-if="on"><p></p><p></p></template></template>' }))).toEqual([expect.stringMatching(/^SN312 .*has 2 elements/)]);
  });
});

describe('scoped styles', () => {
  const INNER = '<template data-sn-props="{ label: string }"><button class="b" data-sn-text="label"></button></template><style>.b { padding: 1px }</style>';
  const OUTER = '<template data-sn-props="{ label: string }"><ui-b class="primary" data-sn-prop="{ label }"></ui-b></template><style>.primary { color: red } :scope { margin: 0 } .primary span { x: y } @media (min-width: 9px) { .primary::before { content: "" } }</style>';
  test('a component tag as root: the element is the inner component\'s, marked with the outer\'s name for its root rules', () => {
    const out = run('<p-b data-sn-prop="{ label: \'x\' }"></p-b>', { 'ui-b': INNER, 'p-b': OUTER });
    expect(errors(out)).toEqual([]);
    expect(body(out)).toBe('<button class="b primary" data-sn="0" data-sn-c="ui-b" data-sn-r="p-b"></button>');
    const css = out.styles.find((x) => x.name === 'p-b')!.css;
    expect(css).toContain('@scope ([data-sn-c="p-b"], [data-sn-s="p-b"])');
    // outside the scope: the rules whose subject is the root, at their own specificity; none that reach inside
    const outside = css.slice(css.lastIndexOf('}\n}') + 3);
    expect(outside).toContain(':where([data-sn-r~="p-b"]):is(.primary){color:red}');
    expect(outside).toContain(':where([data-sn-r~="p-b"]){margin:0}');
    expect(outside).toContain('@media (min-width: 9px){:where([data-sn-r~="p-b"]):is(.primary)::before{content:""}}');
    expect(outside).not.toContain('span');
    // a component used only as a root of its own tag carries no root rules
    expect(run('<ui-b data-sn-prop="{ label: \'x\' }"></ui-b>', { 'ui-b': INNER }).styles[0]!.css).not.toContain('data-sn-r');
  });

  test('an if root\'s branches each carry the marker; a slot root\'s fill does not', () => {
    const CHAIN = '<template data-sn-props="{ on?: boolean }"><template data-sn-if="on"><a></a></template><template data-sn-else><b></b></template></template><style>a, b { x: y }</style>';
    const out = run('<div data-sn-state="{ v: 1 }"><x-c data-sn-prop="{ on: v }"></x-c></div>', { 'x-c': CHAIN });
    expect(out.html).toMatch(/<a data-sn-c="x-c"><\/a>/);
    expect(out.html).toMatch(/<b data-sn-c="x-c"><\/b>/);
    const SLOT = '<template data-sn-props=""><slot><i class="d"></i></slot></template><style>i { x: y }</style>';
    expect(body(run('<x-s><em></em></x-s>', { 'x-s': SLOT }))).toBe('<em data-sn-s=""></em>');
    expect(body(run('<x-s></x-s>', { 'x-s': SLOT }))).toBe('<i class="d" data-sn-c="x-s"></i>');
  });
});
