// Canonical URLs (docs/static-pages.md#canonical-urls): `$site` and `$canonical` from `sinter({ site })`, the
// canonical link the build writes, a page's own, and SN323.
import { describe, expect, test } from 'vitest';
import { compile } from '../../src/compiler/index.js';

const urls = { site: 'https://example.com/docs', canonical: 'https://example.com/docs/guide/install/', origin: 'https://example.com' };
const build = (head: string, body = '', more: Record<string, unknown> = { urls }) => compile(`<!doctype html><html><head><title>x</title>${head}</head><body>${body}</body></html>`, {
  file: '/p/guide/install.html', root: '/p', dev: false, prerender: true,
  helpers: { module: null, names: [], namespaces: {} }, readFile: () => { throw new Error('missing'); }, ...more,
});

describe('$site and $canonical', () => {
  test('build-time constants, written into the HTML; the canonical link written last in the head', () => {
    const out = build('<meta property="og:url" data-sn-attr="{ content: $canonical }"><meta property="og:image" data-sn-attr="{ content: $site + \'/og.png\' }">');
    expect(out.diagnostics).toEqual([]);
    expect(out.html).toContain('<meta property="og:url" content="https://example.com/docs/guide/install/">');
    expect(out.html).toContain('<meta property="og:image" content="https://example.com/docs/og.png">');
    expect(out.html).toContain('<link rel="canonical" href="https://example.com/docs/guide/install/"></head>');
    expect(out.static).toBe(true);
  });

  test('a page\'s own canonical link is $canonical; a relative one is SN323', () => {
    const own = build('<link rel="canonical" href="https://example.com/docs/en/guide/install/"><meta property="og:url" data-sn-attr="{ content: $canonical }">');
    expect(own.html).toContain('<meta property="og:url" content="https://example.com/docs/en/guide/install/">');
    expect(own.html.match(/rel="canonical"/g)).toHaveLength(1);
    const rel = build('<link rel="canonical" href="/en/guide/install/">');
    expect(rel.diagnostics.map((d) => d.code)).toEqual(['SN323']);
    expect(rel.diagnostics[0]!.message).toContain('a canonical link is an absolute URL, and `/en/guide/install/` is not');
  });

  test('without sinter({ site }): SN323, and no canonical link', () => {
    const out = build('<meta property="og:url" data-sn-attr="{ content: $canonical }">', '<p data-sn-text="$site"></p>', {});
    expect(out.diagnostics.map((d) => `${d.code} ${d.message}`)).toEqual([
      "SN323 `$canonical` is the page's absolute URL, and the build does not know the site's origin: set `sinter({ site: 'https://…' })` in vite.config",
      "SN323 `$site` is the site's root URL, and the build does not know the site's origin: set `sinter({ site: 'https://…' })` in vite.config",
    ]);
    expect(out.html).not.toContain('rel="canonical"');
  });

  test('a page whose path is a pattern: the link and $canonical are written by the early script, from the address', () => {
    const out = compile('<!doctype html><html data-sn-path="/article/:slug"><head><title>x</title><meta property="og:url" data-sn-attr="{ content: $canonical }"></head><body></body></html>', {
      file: '/p/article.html', root: '/p', dev: false, prerender: true, early: { module: null, src: null }, observe: true,
      helpers: { module: null, names: [], namespaces: {} }, readFile: () => { throw new Error('missing'); }, urls: { ...urls, canonical: null },
    });
    expect(out.diagnostics).toEqual([]);
    expect(out.html).toMatch(/<link rel="canonical" data-sn="\d+">/);
    expect(out.html).not.toContain('href=');
    expect(out.early).toContain('"https://example.com" + location.pathname.replace(/\\/+$/, \'\')');
    // the link is not why the page runs: the og:url binding is
    expect(out.runtime.map((r) => r.what)).toEqual(['`data-sn-attr`']);
  });
});

test('a page whose path is a pattern with nothing to run: no canonical link, no script (one file answers every URL)', () => {
  const out = compile('<!doctype html><html data-sn-path="/article/:slug"><head><title>x</title></head><body><p>Hello</p></body></html>', {
    file: '/p/article.html', root: '/p', dev: false, prerender: true, embed: true,
    helpers: { module: null, names: [], namespaces: {} }, readFile: () => { throw new Error('missing'); }, urls: { ...urls, canonical: null },
  });
  expect(out.html).not.toContain('rel="canonical"');
  expect(out.runtime).toEqual([]);
});
