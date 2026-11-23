// @vitest-environment node
// The Speculation Rules' paths folded into one pattern (src/prefetch-build.ts `pathsPattern`): from 16 plain paths in
// a rule (a page file per post), one `/(…)` pattern whose regular expression matches exactly those paths stands for
// the list, which grew with the pages in every page's head. The browser must prefetch exactly the same links: each
// app is built with the list (`SN_RULES_FOLD=0`) and folded, and every page's preload candidates in Chromium (the links
// its rules match, `Preload.preloadingAttemptSourcesUpdated`) are compared. Nothing but the rules may differ.
import { createServer, type Server } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { build } from 'vite';
import { afterAll, describe, expect, test } from 'vitest';
import sinter from '../../src/vite.js';
import { pathsPattern } from '../../src/prefetch-build.js';
import { chromium } from '../browser.js';

const src = resolve(__dirname, '../../src');
const alias = [{ find: /^@tiaforge-ui\/sinter\/runtime$/, replacement: `${src}/runtime-entry.ts` }, { find: /^@tiaforge-ui\/sinter\/(?:runtime\/)?(.+)$/, replacement: `${src}/$1.ts` }, { find: /^@tiaforge-ui\/sinter$/, replacement: `${src}/index.ts` }];
const tmp = mkdtempSync(join(tmpdir(), 'sinter-rules-folded-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const walk = (d: string): string[] => readdirSync(d).flatMap((f) => (statSync(join(d, f)).isDirectory() ? walk(join(d, f)) : [join(d, f)]));
const RULES = /<script type="speculationrules">[\s\S]*?<\/script>/;

/** builds `files` with the list and folded; both trees, by file */
async function both(name: string, files: Record<string, string>, input: string[], options: Parameters<typeof sinter>[0] = {}) {
  const root = join(tmp, name);
  for (const [f, s] of Object.entries(files)) { mkdirSync(dirname(join(root, f)), { recursive: true }); writeFileSync(join(root, f), s); }
  const out: Record<'list' | 'folded', Map<string, string>> = { list: new Map(), folded: new Map() };
  for (const k of ['list', 'folded'] as const) {
    const dist = join(root, `dist-${k}`);
    if (k === 'list') process.env.SN_RULES_FOLD = '0'; else delete process.env.SN_RULES_FOLD;
    try {
      await build({ root, logLevel: 'silent', resolve: { alias }, plugins: [sinter({ site: 'https://example.com', ...options })], build: { outDir: dist, emptyOutDir: true, rollupOptions: { input: input.map((f) => join(root, f)) } } });
    } finally { delete process.env.SN_RULES_FOLD; }
    for (const f of walk(dist)) out[k].set(relative(dist, f), readFileSync(f, 'utf8'));
  }
  return { root, ...out };
}

/** a static server for a built tree, as a host serves it (`/a/` from a/index.html, `/a` from a.html) */
function serve(files: Map<string, string>): Promise<{ server: Server; origin: string }> {
  const server = createServer((req, res) => {
    const path = decodeURIComponent((req.url ?? '/').split(/[?#]/)[0]!).slice(1);
    const f = [path, `${path}index.html`, `${path}.html`, `${path}/index.html`].find((x) => files.has(x));
    if (!f) { res.statusCode = 404; res.end('no'); return; }
    res.setHeader('content-type', f.endsWith('.html') ? 'text/html' : f.endsWith('.js') ? 'text/javascript' : 'application/octet-stream');
    res.end(files.get(f));
  });
  return new Promise((ok) => server.listen(0, '127.0.0.1', () => ok({ server, origin: `http://127.0.0.1:${(server.address() as { port: number }).port}` })));
}

/** every HTML page's preload candidates (the links its rules match), by page; a rule set the browser rejects throws */
async function candidates(files: Map<string, string>): Promise<Map<string, string[]>> {
  const { server, origin } = await serve(files);
  const browser = await chromium!.launch();
  const out = new Map<string, string[]>();
  try {
    for (const f of [...files.keys()].filter((x) => x.endsWith('.html')).sort()) {
      const page = await browser.newPage();
      const cdp = await page.context().newCDPSession(page);
      await cdp.send('Preload.enable');
      let seen: string[] = [], error: string | null = null;
      cdp.on('Preload.ruleSetUpdated', (e: { ruleSet: { errorType?: string; errorMessage?: string } }) => { if (e.ruleSet.errorType) error = e.ruleSet.errorMessage ?? e.ruleSet.errorType; });
      cdp.on('Preload.preloadingAttemptSourcesUpdated', (e: { preloadingAttemptSources: Array<{ key: { url: string; action: string } }> }) => { seen = e.preloadingAttemptSources.map((x) => `${x.key.action} ${x.key.url.slice(origin.length)}`).sort(); });
      await page.goto(`${origin}/${f.replace(/index\.html$/, '')}`);
      await page.waitForTimeout(150);
      await page.close();
      if (error) throw new Error(`${f}: the rules were rejected: ${error}`);
      out.set(f, seen);
    }
  } finally { await browser.close(); server.close(); }
  return out;
}

/** the two trees: the same files, which differ in the rules alone; the pages whose rules were folded */
function onlyRules(r: { list: Map<string, string>; folded: Map<string, string> }) {
  expect([...r.folded.keys()].sort()).toEqual([...r.list.keys()].sort());
  const folded: string[] = [];
  for (const [f, a] of r.list) {
    const b = r.folded.get(f)!;
    if (a === b) continue;
    expect(b.replace(RULES, ''), f).toBe(a.replace(RULES, ''));
    expect(RULES.exec(b)![0], f).toContain('"/(');
    folded.push(f);
  }
  return folded;
}

// links of every kind a post can have: the pages, their other URL forms, near misses, files that are not pages
const links = (i: number) => [`/blog/post-${i + 1}/`, `/blog/post-${i + 2}`, `post-${i + 3}/`, `../blog/post-${i + 4}/?x=1#y`, '/blog/post-99/', '/blog/post-1x/', '/blog/post-1/extra',
  '/files/a.pdf', '/blog/post-2.txt', '/blog/post-3.html', '/', '/index.html', '/BLOG/post-1/', 'https://example.org/blog/post-1/'].map((h) => `<a href="${h}">l</a>`).join(' ');
const page = (title: string, body: string, attrs = '') => `<!doctype html><html lang="en"${attrs}><head><meta charset="utf-8"><title>${title}</title></head><body>${body}</body></html>`;

describe.skipIf(!chromium)('the folded rules prefetch exactly what the list did', () => {
  test('a page file per post, two of them off, links to files that are not pages', async () => {
    const added = "<script type=\"module\">for (const h of ['/blog/post-3', '/blog/post-6', '/blog/post-5/', '/blog/post-77', '/blog/post-1x']) { const a = document.createElement('a'); a.href = h; a.textContent = h; document.body.append(a); }</script>";
    const files: Record<string, string> = { 'index.html': page('home', links(0) + added), 'public/files/a.pdf': 'pdf', 'public/blog/post-2.txt': 'txt' };
    const input = ['index.html'];
    for (let i = 0; i < 24; i++) { files[`blog/post-${i}.html`] = page(`p${i}`, links(i), i === 5 || i === 9 ? ' data-sn-prefetch="off"' : ''); input.push(`blog/post-${i}.html`); }
    const r = await both('files', files, input);
    const folded = onlyRules(r);
    expect(folded.length).toBe(25);
    // the rules are no longer a list of every post (two patterns a post): one pattern of a few dozen characters
    const rules = RULES.exec(r.folded.get('blog/post-0/index.html')!)![0];
    expect(rules.length).toBeLessThan(RULES.exec(r.list.get('blog/post-0/index.html')!)![0].length / 3);
    const [a, b] = [await candidates(r.list), await candidates(r.folded)];
    expect(b).toEqual(a);
    // the off pages are not candidates, the others are, in both URL forms
    const home = a.get('index.html')!;
    expect(home).toContain('Prefetch /blog/post-1/');
    expect(home).toContain('Prefetch /blog/post-2/');
    // links a script adds are not rewritten: the other URL form of a page, an off page, no page
    expect(home).toContain('Prefetch /blog/post-3');
    expect(home).not.toContain('Prefetch /blog/post-77');
    expect(home.some((x) => /post-(5|9)\//.test(x))).toBe(false);
    expect(home.some((x) => /a\.pdf|post-2\.txt|post-99|post-1x|extra|BLOG/.test(x))).toBe(false);
  }, 240_000);

  test('a page per entry: its pattern, and the few pages beside it, as they were', async () => {
    const files: Record<string, string> = { 'index.html': page('home', '<a href="/blog/post-1">n</a>') };
    for (let i = 0; i < 24; i++) files[`content/posts/post-${i}.md`] = `---\ntitle: P${i}\n---\nHi.\n`;
    files['blog/post.html'] = `<!doctype html><html lang="en" data-sn-for="post in posts" data-sn-path="/blog/:slug"><head><meta charset="utf-8"><title data-sn-text="post.title"></title></head><body>
<sn-resource name="posts" src="file:/content/posts/*.md"></sn-resource><h1 data-sn-text="post.title"></h1><a href="/blog/post-1">n</a> <a href="/">h</a> <a href="/files/a.pdf">f</a></body></html>`;
    const r = await both('template', files, ['index.html', 'blog/post.html']);
    expect(onlyRules(r)).toEqual([]);
  }, 240_000);

  test('pages in two languages, under their prefixes', async () => {
    const files: Record<string, string> = {
      'src/sinter.content.ts': "import { languages } from '@tiaforge-ui/sinter/content';\nexport const locales = languages({ base: 'en', list: ['en', 'de'] });\n",
    };
    const input: string[] = [];
    for (let i = 0; i < 12; i++) { files[`doc-${i}.html`] = page(`d${i}`, `<a href="/en/doc-${i + 1}/">n</a> <a href="/de/doc-${i + 2}/">d</a> <a href="/doc-${i + 3}/">u</a> <a href="/fr/doc-1/">f</a> <a href="doc-${i + 1}/">r</a>`); input.push(`doc-${i}.html`); }
    const r = await both('locales', files, input, { localePrefix: true });
    expect(onlyRules(r).length).toBeGreaterThan(0);
    const [a, b] = [await candidates(r.list), await candidates(r.folded)];
    expect(b).toEqual(a);
    expect([...a.values()].flat().some((x) => x.includes('/de/doc-'))).toBe(true);
  }, 240_000);
});

test('pathsPattern: the paths, their branches that end alike written once', () => {
  const posts = Array.from({ length: 1000 }, (_, i) => [`/blog/post-${i}/`, `/blog/post-${i}`]).flat();
  expect(pathsPattern(['/', '/index.html', ...posts])).toBe('/((?:blog/post-(?:0(?:/)?|[1-9](?:/|[0-9](?:/|[0-9](?:/)?)?)?)|index\\.html)?)\\?*#*');
  // the class syntax a `v`-flag expression needs (`-` and `/` escaped), ranges only within digits and letters
  expect(pathsPattern(['/a/', '/ab', '/a-', '/a.', '/ac', '/ad'])).toBe('/(a[\\-.\\/b-d])\\?*#*');
  const re = new RegExp(`^${pathsPattern(posts).slice(1, -'\\?*#*'.length)}$`, 'v');
  for (const p of posts) expect(re.test(p.slice(1)), p).toBe(true);
  for (const p of ['/blog/post-1000', '/blog/post-01', '/blog/post-', '/blog/post-1//', '/blog/post-a']) expect(re.test(p.slice(1)), p).toBe(false);
});
