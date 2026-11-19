// The build's HTML minifier (compiler/minify.ts, `sinter({ minifyHtml })`): comments and white space that render
// nothing are removed before the page is compiled, and only where the page's stylesheets decide it.
import { describe, expect, test } from 'vitest';
import { compile } from '../../src/compiler/index.js';

const build = (body: string, css: string | null = '', more: Record<string, unknown> = {}, head = '') => compile(`<!doctype html>\n<html>\n<head>\n<title>x</title>${head}\n</head>\n<body>${body}</body>\n</html>`, {
  file: '/p/index.html', root: '/p', dev: false, prerender: true,
  helpers: { module: null, names: [], namespaces: {} }, readFile: () => { throw new Error('missing'); },
  minify: css === null ? true : { styles: [{ file: 'a.css', css }] }, ...more,
});
const bodyOf = (html: string) => /<body>([\s\S]*)<\/body>/.exec(html)![1]!;
// a page with something to run, so its markup stays as written (not folded at build time)
const live = (inner: string) => `<div data-sn-state="{ on: true, xs: [1, 2] }"><button data-sn-on-click="on = !on; xs = [...xs, 3]">t</button>${inner}</div>`;

describe('comments', () => {
  test("the author's are removed, also in templates; text around them meets", () => {
    const out = build(live(`\n<!-- a note -->\n<p>a <!-- in text --> b</p><template data-sn-if="on"><!-- in a branch --><i>x</i></template>`));
    expect(out.html).not.toMatch(/note|in text|in a branch/);
    expect(bodyOf(out.html)).toContain('<p>a b</p>');
  });

  test('the forms sinter reserves stay, so SN105 still reports them', () => {
    const out = build(live('<p><!--sn 4-->x</p>'));
    expect(out.diagnostics.map((d) => d.code)).toContain('SN105');
  });

  test('without stylesheets only comments go: white space is left as written', () => {
    const out = compile(`<!doctype html><html><head><title>x</title></head><body>${live('\n  <p>a  <!-- c -->  b</p>\n')}</body></html>`, {
      file: '/p/index.html', root: '/p', dev: false, prerender: true, helpers: { module: null, names: [], namespaces: {} }, readFile: () => '', minify: true,
    });
    expect(out.html).toContain('\n  <p>a    b</p>\n');
  });

  test('a stylesheet from another origin: only comments go (it may set any white space or display)', () => {
    const out = build(live('\n  <p>a <!-- c --> b</p>\n'), '', {}, '<link rel="stylesheet" href="https://cdn.example.com/icons.css">');
    expect(out.html).toContain('\n  <p>a  b</p>\n');
    expect(out.html).not.toContain('<!-- c -->');
  });

  test("Google Fonts' stylesheets do not count as another origin's (only @font-face rules)", () => {
    const out = build(live('\n  <p>a</p>\n'), '', {}, '<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter">');
    expect(bodyOf(out.html)).toMatch(/<button[^>]*>t<\/button><p>a<\/p><\/div>/);
  });
});

describe('white space', () => {
  test('runs collapse to one character: a newline when the run had one', () => {
    expect(bodyOf(build(live('<p>a   b\n    c</p>')).html)).toContain('<p>a b\nc</p>');
  });

  test('beside block boxes and at the edges of a block it goes', () => {
    expect(bodyOf(build(live('\n  <section>\n    <h2>T</h2>\n    <p> one </p>\n  </section>\n')).html)).toContain('<section><h2>T</h2><p>one</p></section>');
  });

  test('between inline boxes it stays, as one character: inline-block links keep their gaps', () => {
    const out = build(live('<nav>\n  <a href="/a">A</a>\n  <a href="/b">B</a>\n</nav>'), 'nav a { display: inline-block }');
    expect(bodyOf(out.html)).toContain('<nav><a href="/a">A</a>\n<a href="/b">B</a></nav>');
  });

  test('in a flex or grid container it goes (white space alone is no item)', () => {
    const out = build(live('<div class="row">\n  <span>x</span>\n  <span>y</span>\n</div>'), '.row { display: flex }');
    expect(bodyOf(out.html)).toContain('<div class="row"><span>x</span><span>y</span></div>');
  });

  test('<pre>, <textarea>, `white-space: pre*` and editable content are left as written', () => {
    const out = build(live('<pre>  a\n   b  </pre><textarea>  t  </textarea><p class="pl">a\n   b</p><div contenteditable>  e  </div>'), '.pl { white-space: pre-line }');
    expect(out.html).toContain('<pre>  a\n   b  </pre>');
    expect(out.html).toContain('<textarea>  t  </textarea>');
    expect(out.html).toContain('<p class="pl">a\n   b</p>');
    expect(out.html).toContain('<div contenteditable="">  e  </div>');
  });

  test('a value the stylesheets cannot decide leaves it (a media query that changes white-space)', () => {
    const out = build(live('<p>a   b</p>'), '@media (min-width: 600px) { p { white-space: pre-wrap } }');
    expect(out.html).toContain('<p>a   b</p>');
  });

  test('a display that changes with the viewport: the gap stays where any width keeps it', () => {
    const out = build(live('<nav>\n  <a href="/a">A</a>\n  <a href="/b">B</a>\n</nav>'), 'nav a { display: block } @media (min-width: 600px) { nav a { display: inline-block } }');
    expect(bodyOf(out.html)).toContain('<a href="/a">A</a>\n<a href="/b">B</a>');
  });

  test('`::before` content keeps the white space at the edge of a block (it starts no line there)', () => {
    const out = build(live('<p class="i"> <b>x</b></p>'), '.i::before { content: "•" }');
    expect(bodyOf(out.html)).toContain('<p class="i"> <b>x</b></p>');
  });

  test('an element whose white space was all it held keeps one character (`:empty`)', () => {
    expect(bodyOf(build(live('<div class="e">   </div>')).html)).toContain('<div class="e"> </div>');
  });

  test('a list whose rows are block boxes: the white space around its anchor goes, the list keeps one character', () => {
    const out = build(live('<ul>\n  <template data-sn-for="x in xs">\n    <li>\n      <b>x</b>\n    </li>\n  </template>\n</ul>'));
    expect(bodyOf(out.html)).toMatch(/<ul>\n<!--sn \d+--><!--\/sn--><\/ul>/);
    // a list item's marker is outside its lines: its edges start and end lines too
    expect(out.html).toMatch(/<template id="sn-t-\d+"><li><b>x<\/b><\/li><\/template>/);
  });

  test('a branch that may render inline content keeps the white space beside it', () => {
    const out = build(live('<p><span>a</span> <template data-sn-if="on"><i>b</i></template> <span>c</span></p>'));
    expect(bodyOf(out.html)).toMatch(/<p><span>a<\/span> <!--sn \d+--><!--\/sn--> <span>c<\/span><\/p>/);
  });

  test("markup a component's scoped styles reach is left as written", () => {
    const card = '<template data-sn-props>\n  <div class="c">\n    <b>x</b>\n    <i>y</i>\n  </div>\n</template>\n<style>.c { display: flex }</style>';
    const out = build(live('<x-card></x-card>'), '', { componentNames: ['x-card'], readFile: (f: string) => { if (f === '/p/src/components/x-card.html') return card; throw new Error('missing'); } });
    expect(out.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    expect(out.html).toMatch(/<b>x<\/b>\n    <i>y<\/i>/);
  });

  test('`<head>` and `<html>` lose their white space', () => {
    expect(build(live('')).html).toMatch(/^<!DOCTYPE html><html><head><title>x<\/title>/);
  });
});

describe('node paths are counted on the minified markup', () => {
  test("a row's bound nodes are found after its white space went", () => {
    const out = build(live('<ul>\n  <template data-sn-for="x in xs">\n    <li>\n      <b>label</b>\n      <span data-sn-text="x"></span>\n    </li>\n  </template>\n</ul>'));
    expect(out.html).toMatch(/<template id="sn-t-\d+"><li><b>label<\/b>\n<span><\/span><\/li><\/template>/);
    // the <li>'s children: `<b>`, a newline, `<span>`
    expect(out.module).toContain('"tag":"span","b":[{"k":"text"');
    expect(out.module).toMatch(/"tag":"span"[^}]*\}\],"path":\[0,2\]/);
  });
});
