// The benchmark's app (docs/proposals/axes.md, step 0): a site of `pages` plain pages and a blog template with
// `posts` entries per language, in `langs` languages with `localePrefix`, on one layout with a language switcher
// (`localeUrl()`) and messages. Tenants are today's way: the same app built once per tenant (`TENANT`), each build
// with its own `site`; measure.mjs times all of them. After the axes work, the same site is one build over a tenant
// axis, and this file gains that mode.
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const REPO = resolve(import.meta.dirname, '../..');
export const TAGS = ['en', 'de', 'fr', 'es', 'it', 'nl', 'pl', 'pt', 'sv', 'da', 'fi', 'cs'];
const words = 'page site build text list entry language tenant layout component slot resource field link folder content'.split(' ');
const sentence = (i, j) => Array.from({ length: 10 }, (_, k) => words[(i * 7 + j * 3 + k * 5) % words.length]).join(' ') + '.';

const LAYOUT = (langs) => `<!doctype html>
<html lang="en" data-sn-props="{ title: string; nav: string }">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title data-sn-text="title + ' · ' + m.site()"></title>
  <meta property="og:url" data-sn-attr="{ content: $canonical }">
</head>
<body>
  <header>
    <a href="/index.html" data-sn-text="m.site()"></a>
    <nav>
      <a href="/index.html" data-sn-attr="{ 'aria-current': nav === 'home' ? 'page' : null }" data-sn-text="m.nav_home()"></a>
      <a href="/blog/post-0" data-sn-attr="{ 'aria-current': nav === 'blog' ? 'page' : null }" data-sn-text="m.nav_blog()"></a>
    </nav>
    <nav class="languages">
${langs.map((l) => `      <a hreflang="${l}" data-sn-attr="{ href: localeUrl('${l}'), 'aria-current': $locale === '${l}' ? 'true' : null }">${l}</a>`).join('\n')}
    </nav>
  </header>
  <main><slot></slot></main>
  <footer data-sn-text="m.footer()"></footer>
</body>
</html>
`;

const PAGE = (i, pages) => `<site-layout data-sn-with="{ title: m.page_title({ n: ${i} }), nav: 'page' }">
  <h1 data-sn-text="m.page_title({ n: ${i} })"></h1>
  <p data-sn-text="m.page_text()"></p>
  <ul>
${Array.from({ length: 10 }, (_, k) => `    <li><a href="/page-${(i + k + 1) % pages}.html" data-sn-text="m.page_title({ n: ${(i + k + 1) % pages} })"></a></li>`).join('\n')}
  </ul>
</site-layout>
`;

const POST = `<site-layout data-sn-path="/blog/:slug" data-sn-for="post in posts" data-sn-with="{ title: post.title, nav: 'blog' }">
  <sn-resource name="posts" src="file:/content/{$locale}/posts/*.md" key="id" type="Post"></sn-resource>
  <article>
    <h1 data-sn-text="post.title"></h1>
    <p data-sn-text="post.body"></p>
    <p data-sn-text="m.post_by({ name: post.author })"></p>
  </article>
</site-layout>
`;

/** writes the app into `root`, replacing what is there */
export function writeApp(root, { pages, posts, langs }) {
  rmSync(root, { recursive: true, force: true });
  const tags = TAGS.slice(0, langs);
  const files = {
    'vite.config.js': `import { resolve } from 'node:path';
import { defineConfig } from 'vite';
import sinter from '@tiaforge-ui/sinter/vite';
const tenant = process.env.TENANT ?? 't0';
export default defineConfig({
  logLevel: 'warn',
  plugins: [sinter({ localePrefix: true, site: 'https://' + tenant + '.example.com' })],
  build: { outDir: 'dist/' + tenant, rollupOptions: { input: Object.fromEntries([['index', resolve(import.meta.dirname, 'index.html')], ['post', resolve(import.meta.dirname, 'blog/post.html')], ...Array.from({ length: ${pages} }, (_, i) => ['page-' + i, resolve(import.meta.dirname, 'page-' + i + '.html')])]) } },
});
`,
    'project.inlang/settings.json': JSON.stringify({ baseLocale: 'en', locales: tags, 'plugin.inlang.messageFormat': { pathPattern: './messages/{locale}.json' } }, null, 2),
    'src/layouts/site-layout.html': LAYOUT(tags),
    'src/sinter.types.ts': 'export interface Post { id: string; title: string; author: string }\n',
    'index.html': PAGE(0, pages).replace("nav: 'page'", "nav: 'home'"),
    'blog/post.html': POST,
  };
  for (let i = 0; i < pages; i++) files[`page-${i}.html`] = PAGE(i, pages);
  for (const l of tags) {
    files[`messages/${l}.json`] = JSON.stringify({
      site: `Site ${l}`, nav_home: `Home ${l}`, nav_blog: `Blog ${l}`, footer: `Footer ${l}`,
      page_title: `Page {n} (${l})`, page_text: `${sentence(1, l.length)} (${l})`, post_by: `By {name} (${l})`,
    }, null, 2);
    for (let i = 0; i < posts; i++) files[`content/${l}/posts/post-${i}.md`] = `---\nid: p${i}\ntitle: Post ${i} (${l})\nauthor: Author ${i % 7}\n---\n${sentence(i, 0)} ${sentence(i, 1)}\n`;
  }
  for (const [f, s] of Object.entries(files)) { mkdirSync(dirname(join(root, f)), { recursive: true }); writeFileSync(join(root, f), s); }
  mkdirSync(join(root, 'node_modules/@tiaforge-ui'), { recursive: true });
  symlinkSync(REPO, join(root, 'node_modules/@tiaforge-ui/sinter'), 'dir');
}
