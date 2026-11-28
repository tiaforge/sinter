// `$build` and `$slots` let a component choose how it renders, per use: what the build knows (a body from a `file:`
// resource) and which slots the use fills. An if over `$build` is decided at build time when its inputs are
// constants, and otherwise decided as the browser will see it when that does not depend on runtime data, so the
// page ships one branch. A component's tag attributes reach a component that is a branch of its if/else root.
import { describe, expect, test } from 'vitest';
import { compile } from '../../src/compiler/index.js';
import { mockRequests, render } from '../../src/testing/index.js';

// the template branch when the build knows `v` or a fill is passed; the other one otherwise
const CHOOSER = '<template data-sn-props="{ v: any; tip: Slot<{}> }"><template data-sn-if="($build && (!!v || !v)) || $slots.tip"><b>T<slot name="tip" data-sn-with="{}"></slot></b></template><template data-sn-else><i>S</i></template></template>';

type Options = Parameters<typeof compile>[1];
function built(body: string, components: Record<string, string> = { 'x-s': CHOOSER }) {
  const files: Record<string, string> = {};
  for (const [k, v] of Object.entries(components)) files[`/p/src/components/${k}.html`] = v;
  const o = { file: '/p/index.html', root: '/p', dev: false, prerender: true, componentNames: Object.keys(components), helpers: { module: null, names: [], namespaces: {} }, readFile: (f: string) => { const t = files[f]; if (t === undefined) throw new Error(`no such file: ${f}`); return t; } } as Options;
  const r = compile(`<!doctype html><html><head><title>t</title></head><body>${body}</body></html>`, o);
  const shipped = r.html + r.module;
  return { r, template: shipped.includes('<b>T'), other: shipped.includes('<i>S'), errors: r.diagnostics.filter((d) => d.severity === 'error') };
}
const text = (root: Element) => root.innerHTML.replace(/<!--[^>]*-->/g, '').replace(/<template[\s\S]*?<\/template>/g, '').replace(/ data-sn[-\w]*="[^"]*"/g, '');

describe('one branch per page', () => {
  test('data the build knows: the template branch, written into the page', () => {
    const b = built('<div data-sn-state="{ d: { a: 1 } }"><x-s data-sn-with="{ v: d }"></x-s></div>');
    expect(b.errors).toEqual([]);
    expect([b.template, b.other]).toEqual([true, false]);
    expect(b.r.html).toContain('<b>T</b>');
  });

  test('data only the browser has: the other branch alone, as the browser always takes it', async () => {
    const page = '<div><sn-resource name="v" src="/api/v"></sn-resource><x-s data-sn-with="{ v }"></x-s></div>';
    const b = built(page);
    expect(b.errors).toEqual([]);
    expect([b.template, b.other]).toEqual([false, true]);
    mockRequests({ 'GET /api/v': { a: 1 } });
    const r = await render(page, { components: { 'x-s': CHOOSER } });
    await r.settle();
    expect(text(r.root)).toBe('<div><i>S</i></div>');
  });

  test('a fill: the template branch alone, the fill in it', async () => {
    const page = '<div><sn-resource name="v" src="/api/v"></sn-resource><x-s data-sn-with="{ v }"><u slot="tip">f</u></x-s></div>';
    const b = built(page);
    expect([b.template, b.other]).toEqual([true, false]);
    mockRequests({ 'GET /api/v': { a: 1 } });
    const r = await render(page, { components: { 'x-s': CHOOSER } });
    await r.settle();
    expect(text(r.root)).toBe('<div><b>T<u>f</u></b></div>');
  });

  test('state that something writes is not decided by its initial value: both branches ship and it switches', async () => {
    const C = { 'x-w': '<template data-sn-props="{ v: any; on: boolean }"><template data-sn-if="($build && v) || on"><b>T</b></template><template data-sn-else><i>S</i></template></template>' };
    const page = '<div data-sn-state="{ on: false }"><sn-resource name="v" src="/api/v"></sn-resource><button id="t" data-sn-on-click="on = !on"></button><x-w data-sn-with="{ v, on }"></x-w></div>';
    const b = built(page, C);
    expect(b.errors).toEqual([]);
    expect([b.template, b.other]).toEqual([true, true]);
    mockRequests({ 'GET /api/v': { a: 1 } });
    const r = await render(page, { components: C });
    await r.settle();
    expect(r.root.querySelector('i')).not.toBeNull();
    (r.root.querySelector('#t') as HTMLElement).click();
    await r.flush();
    expect(r.root.querySelector('b')).not.toBeNull();
    expect(r.root.querySelector('i')).toBeNull();
  });
});

describe('state that a handler writes is no build-time constant, also when nothing else is read', () => {
  const page = (cond: string, open: boolean) => `<div data-sn-state="{ open: ${open}, d: { a: 1 } }"><button id="t" data-sn-on-click="open = !open"></button><template data-sn-if="${cond}"><b>T</b></template><template data-sn-else><i>S</i></template></div>`;

  test('`!$build && open`: not decided at build (it was: false, the branch gone for good); the browser shows it when `open` is set', async () => {
    const b = built(page('!$build && open', false), {});
    expect(b.errors).toEqual([]);
    expect([b.template, b.other]).toEqual([true, true]);
    const r = await render(page('!$build && open', false));
    expect(text(r.root)).toBe('<div><button id="t"></button><i>S</i></div>');
    (r.root.querySelector('#t') as HTMLElement).click();
    await r.flush();
    expect(text(r.root)).toBe('<div><button id="t"></button><b>T</b></div>');
  });

  test('`$build && open`: not written into the page from the initial value (it was, and no click could close it); in the browser it is never true, so the other branch ships alone', async () => {
    const b = built(page('$build && open', true), {});
    expect(b.errors).toEqual([]);
    expect([b.template, b.other]).toEqual([false, true]);
    const r = await render(page('$build && open', true));
    expect(text(r.root)).toBe('<div><button id="t"></button><i>S</i></div>');
  });

  test('`($build && d) || open`: in the browser it is `open`, so both branches ship and it switches (it was decided by `d`)', async () => {
    const b = built(page('($build && d) || open', false), {});
    expect([b.template, b.other]).toEqual([true, true]);
    const r = await render(page('($build && d) || open', false));
    expect(text(r.root)).toBe('<div><button id="t"></button><i>S</i></div>');
    (r.root.querySelector('#t') as HTMLElement).click();
    await r.flush();
    expect(text(r.root)).toBe('<div><button id="t"></button><b>T</b></div>');
  });

  test('state nothing writes is decided as before', () => {
    const still = '<div data-sn-state="{ open: true }"><template data-sn-if="$build && open"><b>T</b></template><template data-sn-else><i>S</i></template></div>';
    const b = built(still, {});
    expect([b.template, b.other]).toEqual([true, false]);
    expect(b.r.html).toContain('<b>T</b>');
  });
});

describe('where they may be', () => {
  test('`$build` outside a data-sn-if is SN201: the page would show one thing and the browser another', () => {
    const C = { 'x-t': '<template data-sn-props="{ v: any }"><b data-sn-text="$build ? \'built\' : \'browser\'"></b></template>' };
    const b = built('<div data-sn-state="{ d: 1 }"><x-t data-sn-with="{ v: d }"></x-t></div>', C);
    expect(b.errors.map((d) => d.code)).toContain('SN201');
    expect(b.errors.find((d) => d.code === 'SN201')!.message).toMatch(/only for `data-sn-if`/);
  });

  test('`$slots` outside a component, and in a component used inside itself, is SN201', () => {
    expect(built('<div data-sn-state="{ d: 1 }"><template data-sn-if="$slots.x"><b>x</b></template></div>').errors.map((d) => d.code)).toContain('SN201');
    const C = { 'x-n': '<template data-sn-props="{ node: any }"><b><template data-sn-if="$slots.x"><i>x</i></template><template data-sn-for="c in node.children"><x-n data-sn-with="{ node: c }"></x-n></template></b></template>' };
    const b = built('<div data-sn-state="{ d: { children: [] } }"><x-n data-sn-with="{ node: d }"></x-n></div>', C);
    expect(b.errors.map((d) => d.code)).toContain('SN201');
  });

  test('`$slots` lists the declared slots, each true when this use fills it', async () => {
    const C = { 'x-f': '<template data-sn-props="{ a: Slot<{}>; b: Slot<{}> }"><p><i data-sn-text="($slots.a ? \'a\' : \'-\') + ($slots.b ? \'b\' : \'-\')"></i><slot name="a" data-sn-with="{}"></slot><slot name="b" data-sn-with="{}"></slot></p></template>' };
    const r = await render('<div><x-f><u slot="b">u</u></x-f><x-f></x-f></div>', { components: C });
    expect([...r.root.querySelectorAll('i')].map((i) => i.textContent)).toEqual(['-b', '--']);
  });
});

test('a component\'s tag attributes reach a component that is a branch of its if/else root, in either branch', async () => {
  const C = {
    'x-c': '<template data-sn-props="{ v: number }"><template data-sn-if="v > 1"><x-b data-sn-with="{ v }"></x-b></template><template data-sn-else><x-i data-sn-with="{ v }"></x-i></template></template>',
    'x-b': '<template data-sn-props="{ v: number }"><b data-sn-text="v"></b></template>',
    'x-i': '<template data-sn-props="{ v: number }"><i data-sn-text="v"></i></template>',
  };
  const r = await render('<div data-sn-state="{ n: 2 }"><button data-sn-on-click="n = 0"></button><x-c id="m" class="k" data-sn-with="{ v: n }"></x-c></div>', { components: C });
  const at = () => { const el = r.root.querySelector('#m')!; return `${el.localName}.${el.className}:${el.textContent}`; };
  expect(at()).toBe('b.k:2');
  (r.root.querySelector('button') as HTMLElement).click();
  await r.flush();
  expect(at()).toBe('i.k:0');
});
