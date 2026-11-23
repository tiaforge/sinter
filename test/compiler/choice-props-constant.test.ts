// A choice's case is expanded at build time only when its props are build-time constants (docs/static-pages.md):
// props from state that a handler writes keep the case a run-time choice, as the same component used by its tag
// keeps its bindings live (docs/proposals/redesign-notes/bugs.md, bug 1).
import { describe, expect, test } from 'vitest';
import { compile, type CompileOptions, type ImageHost, type ImageInfo, type ImageVariant } from '../../src/compiler/index.js';

const COMPONENTS: Record<string, string> = {
  'x-img': '<template data-sn-props="{ src: string }"><img alt="" data-sn-attr="{ src }"></template>',
  'x-tag': '<template data-sn-props="{ label: string }"><b data-sn-text="label"></b></template>',
};
const photo: ImageInfo = { width: 1600, height: 1067, alpha: false, kind: 'photo', color: '#8a7f6e', bytes: 200_000, hash: 'abc' };
const images: ImageHost = { info: (f) => (f.endsWith('.jpg') ? photo : undefined), url: (v: ImageVariant) => `/i/photo-${v.width}.${v.format}` };

function build(body: string, o: Partial<CompileOptions> = {}) {
  const files: Record<string, string> = {};
  for (const [k, v] of Object.entries(COMPONENTS)) files[`/p/src/components/${k}.html`] = v;
  return compile(`<!doctype html><html><head></head><body>${body}</body></html>`, {
    file: '/p/index.html', root: '/p', dev: false, prerender: true, componentNames: Object.keys(COMPONENTS),
    helpers: { module: null, names: [], namespaces: {} },
    readFile: (p) => { if (p in files) return files[p]!; throw new Error(`missing ${p}`); }, ...o,
  });
}
const errors = (out: ReturnType<typeof build>) => out.diagnostics.filter((d) => d.severity === 'error').map((d) => `${d.code} ${d.message}`);
const bodyOf = (html: string) => /<body>([\s\S]*)<\/body>/.exec(html)![1]!;

describe('a choice over written state stays a run-time choice', () => {
  const written = (inner: string) => `<div data-sn-state="{ s: 'a.jpg' }">${inner}<button data-sn-on-click="s = 'b.jpg'">b</button></div>`;

  test('an image through a choice\'s prop from written state is not folded into a static <picture>', () => {
    const byTag = build(written('<x-img data-sn-with="{ src: s }"></x-img>'), { images });
    const byChoice = build(written(`<sn-component use="{ a: 'x-img' }['a']" data-sn-with="{ src: s }"></sn-component>`), { images });
    expect(errors(byTag)).toEqual([]);
    expect(errors(byChoice)).toEqual([]);
    // by its tag: the binding stays (no <picture>); through the choice, the same
    expect(bodyOf(byTag.html)).not.toContain('<picture>');
    expect(bodyOf(byChoice.html)).not.toContain('<picture>');
    expect(bodyOf(byChoice.html)).not.toContain('a.jpg"');
  });

  test('a choice\'s text prop from written state is not written into the page as a constant', () => {
    const out = build(written(`<sn-component use="{ a: 'x-tag' }['a']" data-sn-with="{ label: s }"></sn-component>`));
    expect(errors(out)).toEqual([]);
    expect(bodyOf(out.html)).not.toContain('<b>a.jpg</b>');
  });

  test('in an unrolled row: the loop is left to the browser, not rendered with the stale prop', () => {
    const out = build(written(`<ul><template data-sn-for="i in [1, 2]"><li><sn-component use="{ a: 'x-tag' }['a']" data-sn-with="{ label: s }"></sn-component></li></template></ul>`));
    expect(errors(out)).toEqual([]);
    expect(bodyOf(out.html)).not.toContain('<b>a.jpg</b>');
  });

  test('state nothing writes: the case is still expanded at build time', () => {
    const out = build(`<div data-sn-state="{ s: 'a.jpg' }"><sn-component use="{ a: 'x-img' }['a']" data-sn-with="{ src: s }"></sn-component></div>`, { images });
    expect(errors(out)).toEqual([]);
    expect(bodyOf(out.html)).toContain('<picture>');
  });
});
