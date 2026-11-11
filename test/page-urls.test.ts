// Page URLs: links to the app's pages become their URLs, and a page that moves into a directory keeps
// its relative URLs pointing where they did (docs/static-pages.md, step 6 of the proposal).
import { describe, expect, test } from 'vitest';
import { pageRoutes, redirectHtml, redirectsFile, relocateHtml } from '../src/page-urls.js';
import { movesToDirectory, pageFile, pagePaths, pageUrl } from '../src/prefetch-build.js';

const pages = [
  { rel: 'index.html', patterns: [] },
  { rel: 'about.html', patterns: [] },
  { rel: 'login.html', patterns: ['/login'] },
  { rel: 'docs/index.html', patterns: [] },
  { rel: 'docs/getting-started.html', patterns: [] },
  { rel: 'article.html', patterns: ['/article/:slug'] },
  { rel: '404.html', patterns: [] },
];
const at = (rel: string, html: string, base = '/') => relocateHtml(html, pages.find((p) => p.rel === rel)!, pages, base);

describe('which pages move', () => {
  test('a fixed path moves; index, 404, 200 and pages with patterns stay', () => {
    expect(pages.map((p) => pageFile(p.rel, '/', p.patterns))).toEqual(['index.html', 'about/index.html', 'login.html', 'docs/index.html', 'docs/getting-started/index.html', 'article.html', '404.html']);
    // a fixed `data-sn-path` keeps the page where it is, served at exactly that path (`/login`, no slash)
    expect(movesToDirectory('login.html', '/', ['/login'])).toBe(false);
    expect(pageUrl('about.html', '/app/', [])).toBe('/app/about/');
    expect(pagePaths('about.html', '/', [])).toEqual(['/about/', '/about']);
    expect(pagePaths('article.html', '/', ['/article/:slug'])).toEqual(['/article/:slug']);
  });
});

describe('links to pages', () => {
  test('root-relative and relative, with a query and a fragment; other URLs as they were', () => {
    expect(at('index.html', '<a href="/about.html">a</a><a href="about.html?x=1#t">b</a><a href="/about">c</a><a href="/about/">d</a><a href="/login">e</a>'))
      .toBe('<a href="/about/">a</a><a href="about/?x=1#t">b</a><a href="/about/">c</a><a href="/about/">d</a><a href="/login">e</a>');
    expect(at('index.html', '<a href="/article/x">a</a><a href="https://x.dev/about.html">b</a><a href="#top">c</a><a href="mailto:a@b">d</a><img src="logo.png">'))
      .toBe('<a href="/article/x">a</a><a href="https://x.dev/about.html">b</a><a href="#top">c</a><a href="mailto:a@b">d</a><img src="logo.png">');
  });

  test('from a page that moved: relative links to pages, and to itself', () => {
    expect(at('docs/getting-started.html', '<a href="../about.html">a</a><a href="index.html">b</a><a href="getting-started.html">c</a><a href="../index.html">d</a>'))
      .toBe('<a href="../../about/">a</a><a href="../">b</a><a href="./">c</a><a href="../../">d</a>');
  });

  test('under a base: root-relative links name it, relative ones stay relative', () => {
    expect(at('index.html', '<a href="/app/about.html">a</a><a href="about.html">b</a><a href="/other/about.html">c</a>', '/app/'))
      .toBe('<a href="/app/about/">a</a><a href="about/">b</a><a href="/other/about.html">c</a>');
  });
});

describe('a page that moved into a directory', () => {
  test('its relative URLs are rebased; root-relative ones and other schemes stay', () => {
    expect(at('about.html', '<img src="img/a.png" srcset="img/a.png 1x, img/b.png 2x"><link rel="stylesheet" href="./site.css"><form action="send.php"></form><div style="background: url(\'bg.png\')"></div><img src="/logo.png"><img src="data:image/png;base64,x">'))
      .toBe('<img src="../img/a.png" srcset="../img/a.png 1x, ../img/b.png 2x"><link rel="stylesheet" href="../site.css"><form action="../send.php"></form><div style="background: url(\'../bg.png\')"></div><img src="/logo.png"><img src="data:image/png;base64,x">');
    expect(at('about.html', '<style>.a { background: url(bg.png) }</style><script src="./x.js">const a = "<a href=\'about.html\'>";</script><!-- <a href="about.html"> -->'))
      .toBe('<style>.a { background: url(../bg.png) }</style><script src="../x.js">const a = "<a href=\'about.html\'>";</script><!-- <a href="about.html"> -->');
  });

  test('the language picker\'s files (a relative base)', () => {
    const html = '<script src="./assets/head.js" data-sn-i18n="{&#34;files&#34;:{&#34;de&#34;:&#34;./assets/de.js&#34;}}"></script>';
    expect(at('about.html', html)).toBe('<script src="../assets/head.js" data-sn-i18n="{&#34;files&#34;:{&#34;de&#34;:&#34;../assets/de.js&#34;}}"></script>');
  });

  test('a page that does not move keeps its relative URLs', () => {
    expect(at('index.html', '<img src="img/a.png"><link href="site.css">')).toBe('<img src="img/a.png"><link href="site.css">');
  });
});

test('the redirect file at the old path', () => {
  const html = redirectHtml('/about/');
  expect(html).toContain('<meta http-equiv="refresh" content="0; url=/about/">');
  expect(html).toContain('<link rel="canonical" href="/about/">');
  expect(html).toContain('<meta name="robots" content="noindex">');
});

describe('the rules: _redirects and the servers that follow it', () => {
  const site = [
    { rel: 'index.html', patterns: ['/', '/tag/:tag'] },
    { rel: 'about.html', patterns: [] },
    { rel: 'contact.html', patterns: ['/contact/'] },
    { rel: 'login.html', patterns: ['/login'] },
    { rel: 'article.html', patterns: ['/article/:slug'] },
    { rel: 'editor.html', patterns: ['/editor', '/editor/:slug'] },
    { rel: 'help.html', patterns: ['/help', '/support', '/faq'] },
  ];
  test('301 from a moved page\'s file URL, a rewrite per declared path but the one a host serves anyway; fixed paths first', () => {
    expect(pageRoutes(site, '/').map((r) => `${r.from} ${r.to} ${r.status}${r.file ? ' ' + r.file : ''}`)).toEqual([
      '/about.html /about/ 301',
      '/contact.html /contact/ 301',
      '/support /help 200 help.html',
      '/faq /help 200 help.html',
      '/tag/:tag / 200 index.html',
      '/article/:slug /article 200 article.html',
      '/editor/:slug /editor 200 editor.html',
    ]);
  });

  test('under a base', () => {
    expect(pageRoutes([{ rel: 'about.html', patterns: [] }, { rel: 'article.html', patterns: ['/docs/article/:slug'] }], '/docs/').map((r) => `${r.from} ${r.to}`))
      .toEqual(['/docs/about.html /docs/about/', '/docs/article/:slug /docs/article']);
  });

  test('the file: the app\'s own rules first', () => {
    const text = redirectsFile(pageRoutes(site.slice(1, 2), '/'), '/old  /new  301\n');
    expect(text).toBe('/old  /new  301\n\n# written by sinter: the pages\' URLs (docs/static-pages.md#page-urls)\n/about.html  /about/  301\n');
  });
});
