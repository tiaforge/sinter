// @vitest-environment node
// Google Fonts as the app's own CSS (fonts-build.ts): the links a page has, the rewrite and the
// preconnect, a failed download keeping the link, and the download cache.
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, expect, test } from 'vitest';
import { fontDownloader, fontId, fontOrigins, googleFontLinks, inlineFonts } from '../../src/fonts-build.js';

const URL1 = 'https://fonts.googleapis.com/css?family=Titillium+Web:700|Source+Sans+Pro:400,700';
const CSS = "@font-face{font-family:'Source Sans Pro';src:url(https://fonts.gstatic.com/s/ssp/a.woff2) format('woff2')}";
const page = (href: string) => `<!doctype html><html><head><meta charset="utf-8"><title>t</title>
<link rel="stylesheet" href="${href}">
<link rel="stylesheet" href="/styles.css">
<link rel="preload" href="https://fonts.googleapis.com/css?family=X" as="style">
</head><body></body></html>`;

test('finds Google Fonts stylesheet links, with the URL unescaped; not other stylesheets or preloads', () => {
  const links = googleFontLinks(page(URL1.replace('&', '&amp;') + '&amp;display=block'));
  expect(links.map((l) => l.url)).toEqual([URL1 + '&display=block']);
  expect(googleFontLinks(page('https://fonts.googleapis.com/css2?family=Inter:wght@400'))).toHaveLength(1);
  expect(googleFontLinks(page('https://example.com/fonts.css'))).toEqual([]);
});

test('the font files\' origins', () => {
  expect(fontOrigins(CSS + CSS.replace('gstatic', 'other'))).toEqual(['https://fonts.gstatic.com', 'https://fonts.other.com']);
});

test('rewrites the link to its module id and preconnects to the font origin after <meta charset>', async () => {
  const out = await inlineFonts(page(URL1), async () => CSS);
  expect(out.html).toContain(`<link rel="stylesheet" href="${fontId(URL1)}">`);
  expect(out.html).not.toContain('fonts.googleapis.com/css?family=Titillium');
  expect(out.html).toContain('<meta charset="utf-8"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>');
  expect([...out.ids]).toEqual([[fontId(URL1), URL1]]);
  expect(out.failed).toEqual([]);
  // the other stylesheet and the preload are untouched
  expect(out.html).toContain('<link rel="stylesheet" href="/styles.css">');
  expect(out.html).toContain('<link rel="preload" href="https://fonts.googleapis.com/css?family=X" as="style">');
});

test('a stylesheet that cannot be downloaded keeps its link, and no preconnect is added', async () => {
  const out = await inlineFonts(page(URL1), async () => null);
  expect(out.html).toBe(page(URL1));
  expect(out.failed).toEqual([URL1]);
});

const cache = mkdtempSync(join(tmpdir(), 'sinter-fonts-'));
afterAll(() => rmSync(cache, { recursive: true, force: true }));

test('downloads once per URL, as a current Chrome (woff2), and later builds read the cache without the network', async () => {
  const calls: Array<{ url: string; ua: string | null }> = [];
  const fake = (async (url: string, init?: RequestInit) => {
    calls.push({ url, ua: new Headers(init?.headers).get('User-Agent') });
    return new Response(CSS);
  }) as typeof fetch;
  const get = fontDownloader(cache, fake);
  expect(await Promise.all([get(URL1), get(URL1)])).toEqual([CSS, CSS]);
  expect(calls).toHaveLength(1);
  expect(calls[0]!.ua).toMatch(/Chrome\/\d+/);
  expect(readdirSync(cache)).toHaveLength(1);
  const offline = fontDownloader(cache, (async () => { throw new Error('offline'); }) as typeof fetch);
  expect(await offline(URL1)).toBe(CSS);
});

test('a failed download (an error status or no network) is null and not cached', async () => {
  const dir = join(cache, 'failing');
  expect(await fontDownloader(dir, (async () => new Response('', { status: 500 })) as typeof fetch)(URL1)).toBeNull();
  expect(await fontDownloader(dir, (async () => { throw new Error('offline'); }) as typeof fetch)(URL1)).toBeNull();
  expect(() => readdirSync(dir)).toThrow();
});
