// `data-sn-href`: a link's URL template, with the grammar and encoding of an action's URL. It is a bound
// `href` like `data-sn-attr="{ href }"`: the same binding, so first paint, constants, same-page links and
// the rest see a link.
import { describe, expect, test } from 'vitest';
import { compile, compileParts } from '../../src/compiler/index.js';
import { firstPaint, memoryStorage, mockRequests, render } from '../../src/testing/index.js';

const opts = { file: '/p/index.html', root: '/p', dev: false, helpers: { module: null, names: [], namespaces: {} }, readFile: () => '' };
const diags = (html: string) => compileParts(html, opts).diagnostics.map((d) => [d.code, d.message]);

describe('the URL', () => {
  test('each value encoded, as an action\'s; a query value that is null or [] leaves its parameter out, a list repeats it', async () => {
    const requests = mockRequests({ 'GET /api/a': [{ id: 1, user: 'ada lovelace', slug: 'a/b?c', tags: ['x', 'y z'], tab: null }] });
    const r = await render(`<sn-resource name="a" src="/api/a" key="id"></sn-resource>
      <template data-sn-for="x in a">
        <a class="p" data-sn-href="/profile/{x.user}">p</a>
        <a class="s" data-sn-href="/article/{x.slug}/comments">s</a>
        <a class="q" data-sn-href="/search?tab={x.tab}&amp;tag={x.tags}&amp;none={[]}&amp;n={x.id}">q</a>
        <a class="h" data-sn-href="#c-{x.id}">h</a>
        <area class="o" data-sn-href="https://example.com/u/{x.user}">
      </template>`, { requests, strict: true });
    await r.settle();
    const href = (c: string) => r.root.querySelector(`.${c}`)!.getAttribute('href');
    expect(href('p')).toBe('/profile/ada%20lovelace');
    expect(href('s')).toBe('/article/a%2Fb%3Fc/comments');
    expect(href('q')).toBe('/search?tag=x&tag=y%20z&n=1');
    expect(href('h')).toBe('#c-1');
    expect(href('o')).toBe('https://example.com/u/ada%20lovelace');
  });

  test('a path value that is a dot segment is refused, as in an action\'s URL: the link has no href, and a warning says why', async () => {
    const r = await render('<div data-sn-state="{ u: \'..\' }"><a data-sn-href="/profile/{u}/x">p</a><button data-sn-on-click="u = \'x\'">x</button></div>', { strict: false });
    await r.settle();
    expect(r.root.querySelector('a')!.hasAttribute('href')).toBe(false);
    expect(r.warnings().map((w) => w.message).join('\n')).toContain('refused `..` as a URL path value');
    r.root.querySelector('button')!.click();
    await r.settle();
    expect(r.root.querySelector('a')!.getAttribute('href')).toBe('/profile/x/x');
  });

  test('a query-only template: a value that is not set leaves its parameter out, and the link follows the state', async () => {
    const r = await render(`<div data-sn-state="{ tag: null, n: 2 }">
      <a data-sn-href="?tag={tag}&amp;page={n}">next</a>
      <button id="go" data-sn-on-click="tag = 'go'; n = 3">go</button></div>`, { strict: true });
    await r.settle();
    const a = r.root.querySelector('a')!;
    expect(a.getAttribute('href')).toBe('?page=2');
    r.root.querySelector<HTMLElement>('#go')!.click();
    await r.settle();
    expect(a.getAttribute('href')).toBe('?tag=go&page=3');
  });
});

describe('a link in every way', () => {
  test('constants are written into the HTML as a plain href, and the page needs no script for them', () => {
    const out = compile(`<!doctype html><html><head></head><body data-sn-state="{ user: 'ada lovelace' }"><a data-sn-href="/profile/{user}">me</a></body></html>`, { ...opts, prerender: true });
    expect(out.html).toContain('<a href="/profile/ada%20lovelace">me</a>');
    expect(out.html).not.toContain('data-sn-href');
    expect(out.static).toBe(true);
  });

  test('first paint: the early script fills a template over a persisted value, the page module takes it over', async () => {
    const page = `<!doctype html><html><head></head><body data-sn-state="{ tag: 'go' }" data-sn-persist="t"><a data-sn-href="/tag/{tag}?page=2">t</a></body></html>`;
    const storage = memoryStorage();
    storage.setItem('sn:t', JSON.stringify({ tag: 'a b' }));
    await firstPaint(page, { storage });
    const a = document.querySelector('a')!;
    expect(a.getAttribute('href')).toBe('/tag/a%20b?page=2');
    const r = await render(page, { storage, strict: true });
    await r.settle();
    expect(r.root.querySelector('a')!.getAttribute('href')).toBe('/tag/a%20b?page=2');
  });

  test('a link to this page with other parameters is a same-page link', () => {
    const features = (link: string) => compileParts(`<p data-sn-text="$url.page"></p>${link}`, opts).features;
    expect(features('<a data-sn-href="?page={1 + 1}">2</a>')).toContain('query-links');
    expect(features('<a data-sn-href="/other/{1}">o</a>')).not.toContain('query-links');
  });

  test('the code: values through `$hv`, or a query whose values may leave their parameter out through `$hq`, the whole template through `$href` for another shape; imported only when left to the browser', () => {
    const fns = (href: string) => compileParts(`<sn-resource name="u" src="/api/u"></sn-resource><a data-sn-href="${href}">u</a>`, opts);
    const path = fns('/profile/{u.name}/x?tab=a{u.tab}#c-{u.id}');
    expect(path.fns).toContain('($) => ("/profile/" + $hv(($.$r.u.name)) + "/x?tab=a" + $hv(($.$r.u.tab), 1) + "#c-" + $hv(($.$r.u.id), 1))');
    expect(path.helpers.builtin).toEqual(['$hv']);
    const query = fns('/search?tag={u.tag}&amp;page=2');
    expect(query.fns).toContain('($) => ("/search" + $hq([["tag", ($.$r.u.tag)], "page=2"]))');
    expect(query.helpers.builtin).toEqual(['$hq']);
    const odd = fns('/search?tag={u.tag}#a&amp;b');
    expect(odd.fns).toContain('($) => ($href(["/search?tag=",0,"#a&b"], [($.$r.u.tag)]))');
    expect(odd.helpers.builtin).toEqual(['$href']);
    const folded = compileParts('<div data-sn-state="{ n: 1 }"><a data-sn-href="/n/{n}?p={n}">n</a></div>', { ...opts, prerender: true });
    expect(folded.helpers.builtin).toEqual([]);
  });

  test('on a component\'s tag whose root is a link, in the caller\'s scope', async () => {
    const components = { 'nav-link': '<template data-sn-props="{ label: string }"><a data-sn-text="label"></a></template>' };
    const r = await render(`<div data-sn-state="{ u: 'x y' }"><nav-link data-sn-with="{ label: 'me' }" data-sn-href="/profile/{u}"></nav-link></div>`, { components, strict: true });
    await r.settle();
    expect(r.root.querySelector('a')!.getAttribute('href')).toBe('/profile/x%20y');
  });
});

describe('diagnostics', () => {
  test('SN207: a template starts with a literal path, ?, # or origin; a URL from data whole goes in data-sn-attr', () => {
    expect(diags('<div data-sn-state="{ u: \'/x\' }"><a data-sn-href="{u}">x</a></div>')).toEqual([['SN207', expect.stringContaining('a link\'s URL template must start with a literal same-origin path')]]);
    expect(diags('<div data-sn-state="{ h: \'evil.example\' }"><a data-sn-href="//{h}/x">x</a></div>')[0]?.[0]).toBe('SN207');
    expect(diags('<div data-sn-state="{ h: \'x\' }"><a data-sn-href="https://example.com{h}">x</a></div>')[0]?.[0]).toBe('SN207');
    expect(diags('<div data-sn-state="{ s: \'x\' }"><a data-sn-href="javascript:{s}">x</a></div>')[0]?.[0]).toBe('SN207');
    expect(diags('<div data-sn-state="{ n: 1 }"><a data-sn-href="?page={n}">x</a><a data-sn-href="#s-{n}">y</a></div>')).toEqual([]);
  });

  test('SN102: only on a link, and once per element', () => {
    expect(diags('<img alt="" data-sn-href="/a.png">')).toEqual([['SN102', '`data-sn-href` is a link\'s URL, on `<a>` or `<area>`; `<img>` binds its URLs with `data-sn-attr`']]);
    expect(diags(`<a data-sn-href="/a" data-sn-attr="{ href: '/b', title: 'b' }">x</a>`)).toEqual([['SN102', '`href` is bound by `data-sn-href` on this element: bind it once']]);
  });

  test('SN401: an unclosed interpolation', () => {
    expect(diags('<a data-sn-href="/a/{x">x</a>')[0]?.[0]).toBe('SN401');
  });

  test('SN519: a pager template whose literal query drops parameters the page reads', () => {
    const d = (links: string) => diags(`<sn-resource name="a" src="/api/a?tag={$url.tag}" select="a" key="id" paginate="{ numbered: true, size: 2, model: $url.page }"></sn-resource><p data-sn-text="a.length"></p>${links}`);
    expect(d('<template data-sn-for="n in [1, 2]" data-sn-key="n"><a data-sn-href="?page={n}">n</a></template>')).toEqual([['SN519', '`?page={n}` keeps only its own query: `tag`, which this page reads, is dropped when it is followed']]);
    expect(d('<template data-sn-for="n in [1, 2]" data-sn-key="n"><a data-sn-href="?tag={$url.tag}&amp;page={n}">n</a></template>')).toEqual([]);
    // a filter link: page 1 is how the list starts
    expect(d('<a data-sn-href="?tag={\'go\'}">go</a>')).toEqual([]);
  });
});
