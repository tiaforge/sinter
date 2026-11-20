// A component file's one top-level `<template>` is its declaration without `data-sn-props` (a component without
// props): no `data-sn-props=""` needed. `data-sn-props=""` still works; a file whose templates leave it unclear
// which one declares the component is SN312.
import { describe, expect, test } from 'vitest';
import { compile } from '../../src/compiler/index.js';
import { componentKinds, declaringTemplate } from '../../src/compiler/head.js';
import { contractOf } from '../../src/components-build.js';
import { tagCompletions } from '../../src/lsp/markup.js';
import { render } from '../../src/testing/index.js';
import { Component } from '../../src/components.js';
import * as parse5 from 'parse5';

function run(html: string, components: Record<string, string>, scripts: Record<string, string> = {}) {
  const files: Record<string, string> = {};
  for (const [k, v] of Object.entries(components)) files[`/p/src/components/${k}.html`] = v;
  for (const [k, v] of Object.entries(scripts)) files[`/p/src/components/${k}.ts`] = v;
  return compile(html, { file: '/p/index.html', root: '/p', dev: false, helpers: { module: null, names: [], namespaces: {} }, readFile: (p) => { if (p in files) return files[p]!; throw new Error('missing'); } });
}
const codes = (html: string, components: Record<string, string>) => run(html, components).diagnostics.map((d) => `${d.code} ${d.message}`);
const FOOTER = '<template>\n  <footer class="f" data-sn-state="{ year: 2026 }"><p data-sn-text="\'© \' + year"></p></footer>\n</template>\n<style>.f { color: red }</style>\n';

describe('a component without props', () => {
  test('its one top-level `<template>` declares it, with its `<style>`; the same as `data-sn-props=""`', async () => {
    const bare = run('<main><x-foot></x-foot></main>', { 'x-foot': FOOTER });
    const empty = run('<main><x-foot></x-foot></main>', { 'x-foot': FOOTER.replace('<template>', '<template data-sn-props="">') });
    expect(bare.diagnostics).toEqual([]);
    expect(empty.diagnostics).toEqual([]);
    expect(bare.html).toBe(empty.html);
    expect(bare.html).toMatch(/<main><footer class="f" [^>]*><p[^>]*><\/p><\/footer><\/main>/);
    const { root } = await render('<main><x-foot></x-foot></main>', { components: { 'x-foot': FOOTER } });
    expect(root.querySelector('footer p')!.textContent).toBe('© 2026');
  });

  test('a caller that passes props: SN313, as for `data-sn-props=""`', () => {
    expect(codes('<x-foot data-sn-with="{ year: 1 }"></x-foot>', { 'x-foot': FOOTER })).toEqual([expect.stringMatching(/^SN313 `year` is not a prop of `<x-foot>`/)]);
  });

  test('`data-sn-emits` alone: events and no props', async () => {
    const pick = '<template data-sn-emits="{ pick: number }"><button data-sn-on-click="emit(\'pick\', 7)">b</button></template>';
    const { root, settle } = await render('<div data-sn-state="{ got: 0 }"><x-pick data-sn-on-pick="got = $event.detail"></x-pick><p data-sn-text="got"></p></div>', { components: { 'x-pick': pick } });
    root.querySelector('button')!.click();
    await settle();
    expect(root.querySelector('p')!.textContent).toBe('7');
  });

  test('a head component', () => {
    const seo = '<template><meta name="robots" content="noindex"><link rel="me" href="/me"></template>';
    const out = run('<!doctype html><html><head><x-seo></x-seo><title>t</title></head><body><p>x</p></body></html>', { 'x-seo': seo });
    expect(out.diagnostics).toEqual([]);
    expect(/<head>([\s\S]*)<\/head>/.exec(out.html)![1]).toMatch(/^<meta name="robots" content="noindex"><link rel="me" href="\/me"><title>t<\/title>/);
    // in a body: the head component's error, as with `data-sn-props`
    expect(codes('<x-seo></x-seo>', { 'x-seo': seo })).toEqual([expect.stringMatching(/^SN320 `<x-seo>` is a head component/)]);
    // the editor and the generated types read its kind the same way
    const files: Record<string, string> = { 'x-seo': seo, 'x-foot': FOOTER };
    const kind = componentKinds((t) => files[t] ?? null);
    expect([kind('x-seo'), kind('x-foot')]).toEqual(['head', 'body']);
    // completion after `<` in a head component's file offers head components
    const names = [{ name: 'x-seo', kind: 'head' as const, file: '' }, { name: 'x-foot', kind: 'component' as const, file: '' }];
    const text = '<template>\n  <meta name="a" content="b">\n  <';
    expect(tagCompletions(text, text.length, names)!.map((c) => c.label)).toEqual(['x-seo']);
    const body = '<template>\n  <div>\n  <';
    expect(tagCompletions(body, body.length, names)!.map((c) => c.label)).toEqual(['x-foot']);
  });

  test('a component with a script: its contract has no props, and it runs on its root', async () => {
    const ring = '<template><figure data-sn-state="{ n: 0 }"><b data-sn-ref="b" data-sn-text="n"></b></figure></template>';
    expect(contractOf(ring)).toEqual({ props: '{}', emits: '{}', refs: '{ b: HTMLElement }'.replace('HTMLElement', 'HTMLElementTagNameMap["b"]'), state: '{ n: number }' });
    const seen: string[] = [];
    class XRing extends Component<{}, {}, { b: HTMLElement }, { n: number }> {
      connected() { seen.push(this.refs.b.tagName); this.state.n = 3; }
    }
    const { root, flush } = await render('<x-ring></x-ring>', { components: { 'x-ring': ring }, scripts: { 'x-ring': { XRing } } });
    flush();
    expect(seen).toEqual(['B']);
    expect(root.querySelector('b')!.textContent).toBe('3');
    expect(run('<x-ring></x-ring>', { 'x-ring': ring }, { 'x-ring': 'export class XRing {}' }).diagnostics).toEqual([]);
  });
});

describe('which template declares the component', () => {
  test('two top-level templates without `data-sn-props`: SN312', () => {
    expect(codes('<x-two></x-two>', { 'x-two': '<template><p>a</p></template><template><p>b</p></template>' }))
      .toEqual(['SN312 component `<x-two>` has 2 top-level `<template>`s and none has `data-sn-props`: a component file holds one `<template>` around its markup (included from index.html:1)']);
    // one with it: the other belongs inside it, as before
    expect(codes('<x-two></x-two>', { 'x-two': '<template data-sn-props=""><p>a</p></template><template><p>b</p></template>' }))
      .toEqual([expect.stringMatching(/^SN312 a component file holds its `<template>` and `<style>`; `<template>` belongs inside the template/)]);
  });

  test('a branch, a list or a text at the top: SN312 at that attribute, with the template to write', () => {
    for (const a of ['data-sn-if="x"', 'data-sn-for="i in [1]"', 'data-sn-text="\'t\'"']) {
      const name = a.split('=')[0]!;
      const d = run('<x-b></x-b>', { 'x-b': `<template ${a}><p>a</p></template>` }).diagnostics;
      expect(d.map((x) => `${x.code} ${x.message}`)).toEqual([`SN312 the top-level \`<template>\` of \`<x-b>\`'s file is its declaration, around its markup: \`${name}\` cannot be on it (included from index.html:1)`]);
      expect(d[0]!.hint).toBe(`put it on a template inside: \`<template><template ${name}="…">…</template></template>\``);
      // at the attribute's value
      expect([d[0]!.file, d[0]!.col]).toEqual(['/p/src/components/x-b.html', `<template ${a}`.indexOf('=') + 3]);
    }
    // a head component's branch the same: the declaration is around it
    expect(codes('<x-b></x-b>', { 'x-b': '<template data-sn-if="x"><meta name="a" content="b"></template>' })).toEqual([expect.stringMatching(/^SN312 the top-level `<template>` of `<x-b>`'s file is its declaration/)]);
    // inside the declaration, a branch is a root as before
    expect(codes('<x-b></x-b>', { 'x-b': '<template><template data-sn-if="true"><p>a</p></template></template>' })).toEqual([]);
  });

  test('no template: SN312 naming both forms', () => {
    expect(codes('<x-n></x-n>', { 'x-n': '<p>a</p>' })).toEqual([expect.stringMatching(/^SN312 component `<x-n>` needs one `<template>` around its markup \(with `data-sn-props="\{ …props \}"` when it takes props/)]);
  });

  test('declaringTemplate: what the editor, the types and the compiler take as the declaration', () => {
    const of = (html: string) => { const t = declaringTemplate(parse5.parseFragment(html).childNodes); return t ? parse5.serializeOuter(t) : null; };
    expect(of('<template data-sn-props="{ a: number }"><p></p></template>')).toBe('<template data-sn-props="{ a: number }"><p></p></template>');
    expect(of('<!-- doc --><template><p></p></template><style></style>')).toBe('<template><p></p></template>');
    expect(of('<template><p></p></template><template data-sn-props=""><i></i></template>')).toBe('<template data-sn-props=""><i></i></template>');
    expect([of('<template></template><template></template>'), of('<template data-sn-if="x"></template>'), of('<p></p>')]).toEqual([null, null, null]);
  });
});
