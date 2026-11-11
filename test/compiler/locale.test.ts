// A page built in one language (`localePrefix`, docs/static-pages.md#languages): `$locale` and messages are
// constants, in text and attributes; `localeUrl()`; the prefix on `data-sn-path`; the cookie; `$locale` not assignable.
import { describe, expect, test } from 'vitest';
import { compile } from '../../src/compiler/index.js';

const de = { greeting: 'Hallo {name}', title: 'Über uns', label: 'Menü' };
const build = (html: string, locale: Record<string, unknown> = { name: 'de', urls: { en: '/en/about/', de: '/de/about/' }, base: '/' }, file = '/p/about.html') => compile(html, {
  file, root: '/p', dev: false, prerender: true, baseMessages: de, locale,
  helpers: { module: null, names: [], namespaces: { m: { module: '@tiaforge-ui/sinter/messages', members: Object.keys(de) } } },
  readFile: () => { throw new Error('missing'); },
} as never);
const page = (head: string, body: string, html = '<html lang="de">') => `<!doctype html>${html}<head><title>x</title>${head}</head><body>${body}</body></html>`;

describe('a page in one language', () => {
  test('messages and $locale are that language\'s constants, in text and attributes: no JavaScript', () => {
    const out = build(page('<meta name="description" data-sn-attr="{ content: m.title() }">', '<h1 data-sn-text="m.greeting({ name: \'Ada\' })"></h1><nav data-sn-attr="{ \'aria-label\': m.label() }" data-sn-class="{ de: $locale === \'de\' }"></nav>'));
    expect(out.diagnostics).toEqual([]);
    expect(out.html).toContain('<meta name="description" content="Über uns">');
    expect(out.html).toContain('<h1>Hallo Ada</h1>');
    expect(out.html).toContain('<nav aria-label="Menü" class="de"></nav>');
    expect(out.html).not.toContain('data-sn-m');
    expect(out.static).toBe(true);
  });

  test('a message over data: a function of the language\'s text in the page module; no dictionary, no wait', () => {
    const out = build(page('', '<p data-sn-text="m.greeting({ name: $url.who })"></p><p data-sn-text="$url.who ? m.title() : \'\'"></p>', '<html lang="de" data-sn-path="/hi/:who">'), { name: 'de', urls: null, base: '/' }, '/p/hi.html');
    expect(out.diagnostics).toEqual([]);
    expect(out.module).toContain("import { fixed as $fixed } from '@tiaforge-ui/sinter/messages';\n$fixed(\"de\");");
    expect(out.module).toContain('m$greeting = (p = {}) => "Hallo " + ("name" in p ? p["name"] : "{name}") + ""');
    expect(out.module).toContain('m$title = () => "Über uns"');
    expect(out.module).not.toContain('$ready');
    expect(out.module).not.toContain('$m.');
    expect(out.messages).toEqual(['greeting', 'title']);
  });

  test('localeUrl(): this page in another language', () => {
    const out = build(page('', '<a hreflang="en" data-sn-attr="{ href: localeUrl(\'en\') }">English</a>'));
    expect(out.html).toContain('<a hreflang="en" href="/en/about/">English</a>');
  });

  test('a page whose path is a pattern: its patterns under the prefix; localeUrl() from the browser\'s path', () => {
    const out = build(page('', '<a data-sn-attr="{ href: localeUrl(\'en\') }">English</a><p data-sn-text="$url.slug"></p>', '<html lang="de" data-sn-path="/article/:slug">'), { name: 'de', urls: null, base: '/' }, '/p/article.html');
    expect(out.path).toEqual(['/de/article/:slug']);
    expect(out.module).toContain('((l) => "/" + l + location.pathname.slice(3))');
  });

  test('under a base', () => {
    const out = build(page('', '<p data-sn-text="$url.slug"></p>', '<html data-sn-path="/docs/ /docs/article/:slug">'), { name: 'de', urls: null, base: '/docs/' }, '/p/index.html');
    expect(out.path).toEqual(['/docs/de/', '/docs/de/article/:slug']);
  });

  test('a page with a script records its language; $locale cannot be assigned', () => {
    const out = build(page('', '<div data-sn-state="{ n: 0 }"><button data-sn-on-click="n++">+</button><b data-sn-text="n"></b></div>'));
    expect(out.module).toContain('document.cookie = "locale=de; Path=/; Max-Age=31536000; SameSite=Lax";');
    const w = build(page('', '<button data-sn-on-click="$locale = \'en\'">English</button>'));
    expect(w.diagnostics.map((d) => d.code)).toEqual(['SN203']);
    expect(w.diagnostics[0]!.message).toContain("`$locale` is this page's language (`de`)");
  });
});
