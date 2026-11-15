// The constant pre-pass (spec.md, Build-time constants): a binding the build finds constant for good, on an
// `<img>` or a class or style the stylesheets read, is written into the markup before the layout and the images,
// so a folded image is optimized and checked like one written in the page, and a folded class counts for `sizes`.
import { describe, expect, test } from 'vitest';
import { compile, type CompileOptions, type ImageHost, type ImageInfo, type ImageVariant } from '../../src/compiler/index.js';

const photo: ImageInfo = { width: 1600, height: 1067, alpha: false, kind: 'photo', color: '#8a7f6e', bytes: 200_000, hash: 'abc' };
const images: Record<string, ImageInfo | null> = {
  '/app/img/photo.jpg': photo,
  '/app/img/dark.jpg': { ...photo, hash: 'dark' },
  '/app/img/small.jpg': { ...photo, width: 300, height: 200, hash: 'small' },
};
const url = (v: ImageVariant) => `/i/${v.file.slice(v.file.lastIndexOf('/') + 1).replace(/\.\w+$/, '')}-${v.width}.${v.format === 'jpeg' ? 'jpg' : v.format}`;
const host: ImageHost = { info: (f) => (f in images ? images[f] : undefined), url };

function build(body: string, o: { css?: string; files?: Record<string, string>; static?: boolean; host?: ImageHost } = {}) {
  const styles = o.css ? [{ file: '/app/style.css', css: o.css }] : undefined;
  const opts: CompileOptions = {
    file: '/app/index.html', root: '/app', dev: false, prerender: true,
    helpers: { module: '/h.js', names: ['fmt'], namespaces: {} },
    readFile: (p) => { if (o.files && p in o.files) return o.files[p]!; throw new Error('missing'); },
    images: { ...(o.host ?? host), ...(styles ? { styles } : {}) },
    ...(styles ? { styles } : {}),
    ...(o.static ? { static: true } : {}),
  };
  return compile(`<!doctype html><html><head></head><body>${body}</body></html>`, opts);
}
const bodyOf = (html: string) => /<body>([\s\S]*)<\/body>/.exec(html)![1]!;
/** the page as an author would write it with the values in place: what a folded page must compile to */
const written = (body: string, o?: Parameters<typeof build>[1]) => bodyOf(build(body, o).html);

describe('a constant image is optimized', () => {
  test('`src` from state nothing writes: a `<picture>` with `srcset`, `width` and `height`, as if written', () => {
    const out = build('<main data-sn-state="{ pic: \'img/photo.jpg\' }"><img alt="A" data-sn-attr="{ src: pic }"></main>');
    expect(out.diagnostics).toEqual([]);
    expect(bodyOf(out.html)).toBe(written('<main><img alt="A" src="img/photo.jpg"></main>'));
    expect(bodyOf(out.html)).toContain('<picture><source type="image/avif" srcset="/i/photo-480.avif 480w');
    expect(bodyOf(out.html)).toContain('width="1600" height="1067"');
    expect(out.images!.variants.length).toBeGreaterThan(0);
    expect(out.static).toBe(true);
  });

  test('`src` and `alt` from a component\'s props given as literals, one use per line; the URL is the page\'s, as in the browser', () => {
    const files = { '/app/src/components/x-pic.html': '<template data-sn-component="{ src: string; label: string }"><img data-sn-attr="{ src, alt: label }"></template>' };
    const out = build('<x-pic data-sn-prop="{ src: \'img/photo.jpg\', label: \'A\' }"></x-pic>\n<x-pic data-sn-prop="{ src: \'img/small.jpg\', label: \'B\' }"></x-pic>', { files });
    expect(out.diagnostics).toEqual([]);
    expect(bodyOf(out.html)).toBe(written('<img src="img/photo.jpg" alt="A">\n<img src="img/small.jpg" alt="B">'));
  });

  test('a row of a constant loop: each row\'s image, from its item', () => {
    const out = build('<ul><template data-sn-for="p in [{ s: \'img/photo.jpg\', t: \'A\' }, { s: \'img/small.jpg\', t: \'B\' }]"><li><img data-sn-attr="{ src: p.s, alt: p.t }"></li></template></ul>');
    expect(out.diagnostics).toEqual([]);
    expect(bodyOf(out.html)).toBe(written('<ul><li><img src="img/photo.jpg" alt="A"></li><li><img src="img/small.jpg" alt="B"></li></ul>'));
  });

  test('a constant `srcset` is the author\'s, as on an image written with one: left alone', () => {
    const out = build('<main data-sn-state="{ set: \'img/photo.jpg 1x\' }"><img src="img/photo.jpg" alt="" data-sn-attr="{ srcset: set }"></main>');
    expect(out.diagnostics).toEqual([]);
    expect(bodyOf(out.html)).toBe(written('<main><img src="img/photo.jpg" alt="" srcset="img/photo.jpg 1x"></main>'));
    expect(bodyOf(out.html)).not.toContain('<picture>');
  });

  test('a constant class and style count for the box, and so for `sizes`', () => {
    const css = 'main { width: 1000px } img { width: 100px; height: 67px } .big { width: 300px; height: 200px }';
    const out = build('<main data-sn-state="{ big: true }"><img src="img/photo.jpg" alt="" data-sn-class="{ big }"></main>', { css });
    expect(out.diagnostics).toEqual([]);
    expect(bodyOf(out.html)).toContain('sizes="(max-width: 300px) 100vw, 300px"');
    expect(bodyOf(out.html)).toBe(written('<main><img src="img/photo.jpg" alt="" class="big"></main>', { css }));
    // on an ancestor, from a prop, and a style
    const files = { '/app/src/components/x-card.html': '<template data-sn-component="{ wide?: boolean }"><div class="card" data-sn-class="{ wide }"><img src="/img/photo.jpg" alt=""></div></template>' };
    const card = 'main { width: 1000px } .card { width: 200px } .card.wide { width: 500px } .card img { width: 100% }';
    expect(bodyOf(build('<main><x-card data-sn-prop="{ wide: true }"></x-card></main>', { css: card, files }).html)).toContain('sizes="(max-width: 500px) 100vw, 500px"');
    const styled = build('<main data-sn-state="{ w: \'400px\' }"><div data-sn-style="{ width: w }"><img src="img/photo.jpg" alt="" style="width: 100%"></div></main>', { css: 'main { width: 1000px }' });
    expect(bodyOf(styled.html)).toBe(written('<main><div style="width: 400px"><img src="img/photo.jpg" alt="" style="width: 100%"></div></main>', { css: 'main { width: 1000px }' }));
  });

  test('a file not analysed yet is pending, so the adapter analyses it and compiles again', () => {
    const out = build('<main data-sn-state="{ pic: \'img/new.jpg\' }"><img alt="" data-sn-attr="{ src: pic }"></main>');
    expect(out.images!.pending).toEqual(['/app/img/new.jpg']);
  });
});

describe('a folded image is checked like one written in the page', () => {
  test('SN513 is for an image whose `src` changes: a choice over constants folds, and is optimized', () => {
    const folded = build('<main data-sn-state="{ dark: false }"><img alt="" data-sn-attr="{ src: dark ? \'img/dark.jpg\' : \'img/photo.jpg\' }"></main>');
    expect(folded.diagnostics).toEqual([]);
    expect(bodyOf(folded.html)).toBe(written('<main><img alt="" src="img/photo.jpg"></main>'));
    // a handler writes `dark`: the binding stays, and so does the warning
    const bound = build('<main data-sn-state="{ dark: false }"><img alt="" data-sn-attr="{ src: dark ? \'img/dark.jpg\' : \'img/photo.jpg\' }"><button data-sn-on-click="dark = !dark"></button></main>');
    expect(bound.diagnostics.map((d) => d.code)).toEqual(['SN513']);
    expect(bodyOf(bound.html)).not.toContain('<picture>');
  });

  test('the image warnings of a written image: SN511 and SN512, at the folded image', () => {
    const small = build('<main data-sn-state="{ pic: \'img/small.jpg\' }"><img alt="" width="200" data-sn-attr="{ src: pic }"></main>');
    expect(small.diagnostics.map((d) => [d.code, d.message])).toEqual([['SN511', '`img/small.jpg` is 300 px wide; the 200 px box needs 400 px to be sharp on 2x screens']]);
    const ratio = build('<main data-sn-state="{ pic: \'img/photo.jpg\' }"><img alt="" width="200" height="200" data-sn-attr="{ src: pic }"></main>');
    expect(ratio.diagnostics.map((d) => d.code)).toEqual(['SN512']);
  });

  test('an attribute with another diagnostic is not folded early, so it is reported again', () => {
    const out = build('<main data-sn-state="{ pic: \'img/photo.jpg\' }"><img alt="" data-sn-attr="{ src: pic, onclick: pic }"></main>');
    expect(out.diagnostics.map((d) => d.code)).toEqual(['SN207']);
  });
});

describe('what stays as it was', () => {
  test('a static page stays static: no SN322, no script, the image optimized', () => {
    const out = build('<main data-sn-state="{ pic: \'img/photo.jpg\', big: true }"><img alt="" data-sn-attr="{ src: pic }" data-sn-class="{ big }"></main>', { static: true, css: '.big { width: 300px }' });
    expect(out.diagnostics).toEqual([]);
    expect(out.static).toBe(true);
    expect(out.html).not.toContain('<script');
    expect(bodyOf(out.html)).toContain('<picture>');
  });

  test('state something writes, a resource, a helper: bound, as before', () => {
    const kept = (body: string) => bodyOf(build(body).html);
    expect(kept('<main data-sn-state="{ pic: \'img/photo.jpg\' }"><img alt="" data-sn-attr="{ src: pic }"><button data-sn-on-click="pic = \'img/small.jpg\'"></button></main>')).not.toContain('<picture>');
    expect(kept('<sn-resource name="u" src="/api/u"></sn-resource><img alt="" data-sn-attr="{ src: u.pic }">')).not.toContain('<picture>');
    expect(kept('<img alt="" data-sn-attr="{ src: fmt() }">')).not.toContain('<picture>');
  });

  test('two uses of a component on one line: told apart by where each tag is, so each image is optimized', () => {
    const files = { '/app/src/components/x-pic.html': '<template data-sn-component="{ src: string }"><img alt="" data-sn-attr="{ src }"></template>' };
    const out = build('<x-pic data-sn-prop="{ src: \'img/photo.jpg\' }"></x-pic><x-pic data-sn-prop="{ src: \'img/small.jpg\' }"></x-pic>', { files });
    expect(bodyOf(out.html)).toBe(written('<img alt="" src="img/photo.jpg"><img alt="" src="img/small.jpg">'));
  });

  test('a class or style that reaches no image and no reserved list: written after the walk, as before (its node had an id, so the ids after it stay)', () => {
    const page = '<main data-sn-state="{ on: true, n: 0 }"><p data-sn-class="{ on }">x</p><button data-sn-on-click="n++" data-sn-text="n"></button></main>';
    const after = '<main data-sn="0"><p class="on">x</p><button data-sn="2">0</button></main>';
    const early = '<main data-sn="0"><p class="on">x</p><button data-sn="1">0</button></main>';
    // no stylesheet names it, or one does and it reaches nothing that feeds the layout
    expect(bodyOf(build(page, { css: '.off { width: 1px }' }).html)).toBe(after);
    expect(bodyOf(build(page, { css: '.on { width: 1px }' }).html)).toBe(after);
    expect(bodyOf(build(page.replace('data-sn-class="{ on }"', 'data-sn-style="{ width: \'1px\' }"'), { css: 'p { color: red }' }).html)).toBe(after.replace('<p class="on">', '<p style="width: 1px">'));
    // a selector that goes on to the siblings after it, where an image is; `:has()` may reach anything
    const img = page.replace('</button>', '</button><img src="/img/photo.jpg" alt="">');
    expect(bodyOf(build(img, { css: '.on ~ img { width: 10px }' }).html)).toContain('<button data-sn="1">');
    expect(bodyOf(build(img, { css: '.on { width: 10px }' }).html)).toContain('<button data-sn="2">');
    expect(bodyOf(build(page, { css: 'main:has(.on) { width: 10px }' }).html)).toBe(early);
    // the escaped form a stylesheet writes
    expect(bodyOf(build(page.replace('{ on }', '{ \'md:w-1/2\': on }'), { css: 'main:has(.md\\:w-1\\/2) { width: 50% }' }).html)).toContain('<button data-sn="1">');
  });

  test('a class without stylesheets, and a constant text: written after the walk, as before', () => {
    const out = build('<main data-sn-state="{ on: true, t: \'x\' }"><p data-sn-class="{ on }" data-sn-text="t"></p></main>');
    expect(bodyOf(out.html)).toBe('<main><p class="on">x</p></main>');
  });
});
