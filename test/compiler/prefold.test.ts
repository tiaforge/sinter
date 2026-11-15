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

describe('the dry run and reserved space', () => {
  // a paginated list holds its rows' space; the dry run takes `planSpace`'s result over when nothing it read changed
  const page = (around: string, cls: string) => `<sn-resource name="items" src="/api/items" key="id" paginate="offset" page-size="10"></sn-resource>
<section data-sn-state="{ dense: true, n: 0 }"><p${around}>x</p><ul${cls}><template data-sn-for="r in items" data-sn-key="r.id"><li class="row" data-sn-text="r.name"></li></template></ul><button data-sn-on-click="n++" data-sn-text="n"></button></section>`;
  const css = '.row { height: 56px } .dense .row { height: 30px } p.dense { color: red }';
  const paint = (body: string) => {
    const out = compile(`<!doctype html><html><head></head><body>${body}</body></html>`, {
      file: '/app/index.html', root: '/app', dev: false, prerender: true, paintCss: '/@sinter/paint.css',
      helpers: { module: '/h.js', names: [], namespaces: {} }, readFile: () => { throw new Error('missing'); },
      styles: [{ file: '/app/style.css', css }],
    });
    expect(out.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    return { paint: out.paint ?? '', html: bodyOf(out.html) };
  };

  test('a class that does not change the list: its space as before, and no second compile', () => {
    const folded = paint(page(' data-sn-class="{ dense }"', ''));
    expect(folded.paint).toBe(paint(page(' class="dense"', '')).paint);
    expect(folded.paint).toContain('height:560px');
    // (its node had an id, so the ids after it stay: the anchor 2, the button 3)
    expect(folded.html).toMatch(/<button data-sn="3">/);
  });

  test('a class on the list\'s container that changes its rows: the space of the page written by hand', () => {
    const folded = paint(page('', ' data-sn-class="{ dense }"'));
    expect(folded.paint).toBe(paint(page('', ' class="dense"')).paint);
    expect(folded.paint).toContain('height:300px');
    // compiled again with the class in place: the list's container has no node, the button is 2
    expect(folded.html).toMatch(/<button data-sn="2">/);
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

  test('a class or style that changes nothing the layout feeds: written after the walk, as before (its node had an id, so the ids after it stay)', () => {
    const page = '<main data-sn-state="{ on: true, n: 0 }"><p data-sn-class="{ on }">x</p><button data-sn-on-click="n++" data-sn-text="n"></button></main>';
    const after = '<main data-sn="0"><p class="on">x</p><button data-sn="2">0</button></main>';
    // no stylesheet names it, or the page has no image or list for it to change, whatever its rules say
    expect(bodyOf(build(page, { css: '.off { width: 1px }' }).html)).toBe(after);
    expect(bodyOf(build(page, { css: '.on { width: 1px }' }).html)).toBe(after);
    expect(bodyOf(build(page, { css: 'main:has(.on) { width: 10px }' }).html)).toBe(after);
    expect(bodyOf(build(page.replace('data-sn-class="{ on }"', 'data-sn-style="{ width: \'1px\' }"'), { css: 'p { color: red }' }).html)).toBe(after.replace('<p class="on">', '<p style="width: 1px">'));
    // with an image: a rule that changes its box takes the fold before the layout (the next id), one that does not leaves it
    const img = page.replace('</button>', '</button><img src="/img/photo.jpg" alt="">');
    expect(bodyOf(build(img, { css: '.on ~ img { width: 10px }' }).html)).toContain('<button data-sn="1">');
    expect(bodyOf(build(img, { css: '.on { width: 10px }' }).html)).toContain('<button data-sn="2">');
    // the escaped form a stylesheet writes
    expect(bodyOf(build(img.replace('{ on }', '{ \'md:w-1/2\': on }'), { css: '.md\\:w-1\\/2 ~ img { width: 50px }' }).html)).toContain('<button data-sn="1">');
  });

  test('a class on a flex or grid sibling that changes an image\'s width: the dry run finds it, and the page is compiled again with it', () => {
    const flex = '.row { display: flex } aside { flex: none; width: 200px } aside.wide { width: 400px } .body { flex: 1 } .body img { width: 100% }';
    const page = (cls: string) => `<section data-sn-state="{ wide: true, n: 0 }"><div class="row"><aside${cls}>menu</aside><div class="body"><img src="/img/photo.jpg" alt=""></div></div><button data-sn-on-click="n++" data-sn-text="n"></button></section>`;
    const folded = build(page(' data-sn-class="{ wide }"'), { css: flex });
    expect(folded.diagnostics).toEqual([]);
    // the rest of the viewport after a 400 px aside, not a 200 px one
    expect(bodyOf(folded.html)).toContain('calc(100vw - 416px)');
    // as the page written by hand
    expect(bodyOf(folded.html).replace(/ data-sn="\d+"/g, '')).toBe(written(page(' class="wide"'), { css: flex }).replace(/ data-sn="\d+"/g, ''));
    // a grid's track
    const grid = '.row { display: grid; grid-template-columns: 200px 1fr } .row.wide { grid-template-columns: 500px 1fr } .body img { width: 100% }';
    const g = (cls: string) => `<section data-sn-state="{ wide: true, n: 0 }"><div${cls}><aside>menu</aside><div class="body"><img src="/img/photo.jpg" alt=""></div></div><button data-sn-on-click="n++" data-sn-text="n"></button></section>`;
    const gf = build(g(' class="row" data-sn-class="{ wide }"'), { css: grid });
    expect(bodyOf(gf.html)).toContain('calc(100vw - 516px)');
    expect(bodyOf(gf.html).replace(/ data-sn="\d+"/g, '')).toBe(written(g(' class="row wide"'), { css: grid }).replace(/ data-sn="\d+"/g, ''));
    // even a class that only colors the aside: unfolded, the layout cannot tell its width, and the image got `100vw`
    const color = flex.replace('aside.wide { width: 400px }', 'aside.wide { color: red }');
    expect(bodyOf(build(page(' data-sn-class="{ wide }"'), { css: color }).html)).toContain('calc(100vw - 216px)');
    // a class outside the row, which the layout of the image does not read: no second compile (the ids after it stay)
    const outside = `<section data-sn-state="{ wide: true, n: 0 }"><div class="row"><aside>menu</aside><div class="body"><img src="/img/photo.jpg" alt=""></div></div><p data-sn-class="{ wide }">x</p><button data-sn-on-click="n++" data-sn-text="n"></button></section>`;
    expect(bodyOf(build(outside, { css: flex + ' p.wide { width: 10px }' }).html)).toContain('<button data-sn="2">');
    expect(bodyOf(folded.html)).toContain('<button data-sn="1">');
  });

  test('a class without stylesheets, and a constant text: written after the walk, as before', () => {
    const out = build('<main data-sn-state="{ on: true, t: \'x\' }"><p data-sn-class="{ on }" data-sn-text="t"></p></main>');
    expect(bodyOf(out.html)).toBe('<main><p class="on">x</p></main>');
  });
});
