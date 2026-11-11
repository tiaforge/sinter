// Layouts (docs/proposals/layouts.md): a page that is a layout's tag becomes the layout's document,
// its slots filled with the tag's content, the tag's attributes on `<html>`.
import { describe, expect, test } from 'vitest';
import { compile } from '../../src/compiler/index.js';

const LAYOUT = `<!-- the site's document: not part of any page -->
<!doctype html>
<html lang="en" class="site" data-sn-layout="{ title?: string; nav: string }">
<head>
  <meta charset="utf-8">
  <seo-tags data-sn-prop="{ title }"></seo-tags>
  <link rel="stylesheet" href="./site.css">
  <script type="module" src="../main.ts"></script>
  <slot name="head"></slot>
</head>
<body>
  <header><a href="/" data-sn-class="{ active: nav == 'home' }">Home</a><x-nav></x-nav></header>
  <main><slot></slot></main>
  <footer><slot name="footer">© me</slot></footer>
</body>
</html>`;
const SEO = '<template data-sn-head="{ title?: string }"><title data-sn-text="title ? title + \' · Blog\' : \'Blog\'">Blog</title></template>';
const NAV = '<template data-sn-component=""><nav><a href="./about">About</a></nav></template>';

function run(page: string, extra: Record<string, string> = {}, file = '/p/post.html') {
  const files: Record<string, string> = {
    '/p/src/layouts/site-layout.html': LAYOUT, '/p/src/components/seo-tags.html': SEO, '/p/src/components/x-nav.html': NAV,
    ...extra,
  };
  return compile(page, { file, root: '/p', dev: false, helpers: { module: null, names: [], namespaces: {} }, readFile: (p) => { if (p in files) return files[p]!; throw new Error('missing'); } });
}
const errors = (out: ReturnType<typeof run>) => out.diagnostics.filter((d) => d.severity === 'error').map((d) => `${d.code} ${d.message}`);

const PAGE = `<site-layout lang="de" class="post" data-sn-path="/post/:slug" data-sn-state="{ tab: 'a' }" data-sn-prop="{ nav: 'home', title: post?.title ?? tab }">
  <sn-resource name="post" src="/api/posts/{$url.slug}"></sn-resource>
  <meta slot="head" name="robots" content="noindex">
  <article><h1 data-sn-text="post.title + tab"></h1></article>
  <p slot="footer">mine</p>
</site-layout>`;

describe('the merge', () => {
  test('the page is the layout\'s document: slots in head and body, the tag\'s attributes on <html>', () => {
    const out = run(PAGE);
    expect(errors(out)).toEqual([]);
    expect(out.html).toMatch(/^<!DOCTYPE html><html lang="de" class="site post" data-sn="0">/);
    const head = /<head>([\s\S]*)<\/head>/.exec(out.html)![1]!;
    expect(head).toMatch(/<meta charset="utf-8">\s*<title data-sn="\d+">Blog<\/title>\s*<link rel="stylesheet" href="\/src\/layouts\/site.css">\s*<script type="module" src="\/src\/main.ts"><\/script>\s*<meta name="robots" content="noindex">/);
    expect(out.html).toMatch(/<main>\s*<article><h1 data-sn="\d+"><\/h1><\/article>\s*<\/main>/);
    expect(out.html).toContain('<footer><p>mine</p></footer>');
    expect(out.html).not.toMatch(/site-layout|<slot|data-sn-layout|data-sn-path|not part of any page/);
    expect(out.path).toEqual(['/post/:slug']);
    // a component's relative URL is not rebased: only the layout's own
    expect(out.html).toContain('<a href="./about">');
  });

  test('the page\'s state is on <html>: the props and the slot content see it, the layout does not', () => {
    const out = run(PAGE);
    expect(out.module).toContain("($) => ({ tab: 'a' })");
    expect(out.module).toContain("($.$r.post?.title ?? $.$s0.tab)");
    expect(out.module).toContain('($) => ($.$r.post.title + $.$s0.tab)');
    const inLayout = run(PAGE, { '/p/src/layouts/site-layout.html': LAYOUT.replace('<main>', '<main data-sn-text="tab">') });
    expect(errors(inLayout)).toEqual([expect.stringMatching(/^SN201 `tab` is not defined/)]);
  });

  test('a handler on the tag is on <html>, for any event that bubbles up the page, in the page\'s scope', () => {
    const out = run('<site-layout data-sn-state="{ err: null }" data-sn-prop="{ nav: \'x\' }" data-sn-on-sn-error="err = $event.detail.error"><p>x</p></site-layout>');
    expect(errors(out)).toEqual([]);
    expect(out.module).toMatch(/"tag":"html","b":\[\{"k":"on","f":\d+,"n":"sn-error"/);
  });

  test('fallback content stays when the page leaves a slot empty', () => {
    expect(run('<site-layout data-sn-prop="{ nav: \'x\' }"><p>x</p></site-layout>').html).toContain('<footer>© me</footer>');
  });

  test('a missing prop, an unknown slot, as for components', () => {
    expect(errors(run('<site-layout><p>x</p></site-layout>'))).toEqual([expect.stringMatching(/^SN313 `<site-layout>` needs the prop `nav`/)]);
    expect(errors(run('<site-layout data-sn-prop="{ nav: \'x\' }"><p slot="side">x</p></site-layout>'))).toEqual([expect.stringMatching(/^SN314 `<site-layout>` has no slot `side`/)]);
  });
});

describe('errors', () => {
  test('SN319: a page that uses a layout is only its tag', () => {
    expect(errors(run('<p>before</p><site-layout data-sn-prop="{ nav: \'x\' }"></site-layout>'))).toEqual([expect.stringMatching(/^SN319 a page that uses the layout `<site-layout>` is only its tag: `<p>` belongs inside it/)]);
    expect(errors(run('<!doctype html><html><head><title>t</title></head><body><site-layout data-sn-prop="{ nav: \'x\' }"></site-layout></body></html>'))).toEqual([expect.stringMatching(/^SN319 .*`<title>` belongs inside it/)]);
    expect(errors(run('<site-layout data-sn-early="off" data-sn-prop="{ nav: \'x\' }"></site-layout>'))).toEqual([expect.stringMatching(/^SN319 `data-sn-early` cannot be on a layout's tag/)]);
  });

  test('SN319: a layout tag below the top level, or inside a component', () => {
    expect(errors(run('<site-layout data-sn-prop="{ nav: \'x\' }"><div><site-layout></site-layout></div></site-layout>'))).toEqual([expect.stringMatching(/^SN319 `<site-layout>` is a layout: it is the only tag of a page/)]);
  });

  test('SN320: a head element given to a body slot', () => {
    expect(errors(run('<site-layout data-sn-prop="{ nav: \'x\' }"><meta name="robots" content="x"></site-layout>'))).toEqual([expect.stringMatching(/^SN320 `<meta>` is a head element: content without `slot` goes into the layout's body/)]);
    expect(errors(run('<site-layout data-sn-prop="{ nav: \'x\' }"><title slot="footer">t</title></site-layout>'))).toEqual([expect.stringMatching(/^SN320 `<title>` is a head element: `footer` is not a head slot/)]);
  });

  test('SN321: a second title in the merged head', () => {
    const d = errors(run('<site-layout data-sn-prop="{ nav: \'x\' }"><title slot="head">mine</title></site-layout>'));
    expect(d).toEqual([expect.stringMatching(/^SN321 a second `<title>` in the head/)]);
    // metas that may repeat are fine
    expect(errors(run('<site-layout data-sn-prop="{ nav: \'x\' }"><meta slot="head" property="og:image" content="/a.png"><meta slot="head" property="og:image" content="/b.png"></site-layout>'))).toEqual([]);
  });

  test('SN318: a layout that is not a document, a default slot in its head, a script beside it, a name shared with a component, a layout built as a page', () => {
    expect(errors(run('<x-bad></x-bad>', { '/p/src/layouts/x-bad.html': '<div><slot></slot></div>' }))).toEqual([expect.stringMatching(/^SN318 `src\/layouts\/x-bad.html` is not a layout/)]);
    expect(errors(run('<x-l></x-l>', { '/p/src/layouts/x-l.html': '<!doctype html><html data-sn-layout=""><head><slot></slot></head><body></body></html>' }))).toEqual([expect.stringMatching(/^SN318 the default slot of a layout is in its body/)]);
    expect(errors(run('<x-l></x-l>', { '/p/src/layouts/x-l.html': '<!doctype html><html data-sn-layout=""><head></head><body><slot></slot></body></html>', '/p/src/layouts/x-l.ts': '' }))).toEqual([expect.stringMatching(/^SN318 the layout `<x-l>` has a script/)]);
    expect(errors(run('<x-nav></x-nav>', { '/p/src/layouts/x-nav.html': LAYOUT }))).toEqual([expect.stringMatching(/^SN318 `<x-nav>` is both a layout/)]);
    expect(errors(run('<p data-sn-layout=""></p>'))).toEqual([expect.stringMatching(/^SN318 `data-sn-layout` belongs on the `<html>` of a layout file/)]);
    expect(errors(run(LAYOUT, {}, '/p/src/layouts/site-layout.html'))[0]).toMatch(/^SN318 a layout is not a page/);
  });
});
