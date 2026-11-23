// The sinter site (README.md): one template page builds every post (`data-sn-for` on `<html>`), rendered with
// sinter-markdown's components; with `files`, each post is a page of its own.
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { post, title } from './content.mjs';

const REPO = resolve(import.meta.dirname, '../..');

const LIVE = (slug) => `<section data-sn-state="{ draft: '', open: false }">
  <sn-resource name="comments" src="/api/comments?post={${slug}}" select="comments" key="id" type="any"></sn-resource>
  <button data-sn-on-click="open = !open" data-sn-text="open ? 'Hide comments' : 'Show comments'"></button>
  <ul data-sn-show="open"><template data-sn-for="c in comments"><li data-sn-class="{ own: c.own }"><b data-sn-text="c.author"></b> <span data-sn-text="c.body"></span></li></template></ul>
  <input data-sn-model="draft"><p data-sn-text="draft.length + ' characters'"></p>
</section>`;

const PAGE = (src, attrs, live) => `<!doctype html>
<html lang="en"${attrs}>
<head><meta charset="utf-8"><title data-sn-text="post.title"></title></head>
<body>
${src}
<main data-sn-let="{ doc: md.parse(post.body) }">
  <h1 data-sn-text="post.title"></h1>
  <md-doc data-sn-with="{ doc }"></md-doc>
</main>
${live}
</body>
</html>
`;

const INDEX = (n) => `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Blog</title></head>
<body>
<ul>
${Array.from({ length: n }, (_, i) => `  <li><a href="/blog/post-${i}/">Post ${i}</a></li>`).join('\n')}
</ul>
</body>
</html>
`;

export function writeSinterApp(root, { n, files = false, typecheck = false, live = false }) {
  rmSync(root, { recursive: true, force: true });
  const out = {
    'vite.config.js': `import { resolve } from 'node:path';
import { defineConfig } from 'vite';
import sinter from '@tiaforge-ui/sinter/vite';
const n = ${n};
export default defineConfig({
  logLevel: 'warn',
  plugins: [sinter({ libraries: ['@tiaforge-ui/sinter-markdown'], site: 'https://example.com', typecheck: ${typecheck} })],
  build: { rollupOptions: { input: Object.fromEntries([['index', resolve(import.meta.dirname, 'index.html')], ...(${!files} ? [['post', resolve(import.meta.dirname, 'blog/post.html')]] : Array.from({ length: n }, (_, i) => ['post-' + i, resolve(import.meta.dirname, 'blog/post-' + i + '.html')]))]) } },
});
`,
    'src/sinter.helpers.ts': "export * as md from '@tiaforge-ui/sinter-markdown';\n",
    'src/sinter.types.ts': "export type { Root } from '@tiaforge-ui/sinter-markdown';\n/** a post's frontmatter */\nexport interface Post { title: string }\n",
    'index.html': INDEX(n),
  };
  if (!files) out['blog/post.html'] = PAGE('<sn-resource name="posts" src="file:/content/posts/*.md" type="Post"></sn-resource>', ' data-sn-path="/blog/:slug" data-sn-for="post in posts"', live ? LIVE('post.slug') : '');
  else for (let i = 0; i < n; i++) out[`blog/post-${i}.html`] = PAGE(`<sn-resource name="post" src="file:/content/posts/post-${i}.md" type="Post"></sn-resource>`, '', live ? LIVE(`'post-${i}'`) : '');
  for (const [f, s] of Object.entries(out)) { mkdirSync(dirname(join(root, f)), { recursive: true }); writeFileSync(join(root, f), s); }
  mkdirSync(join(root, 'content/posts'), { recursive: true });
  for (let i = 0; i < n; i++) writeFileSync(join(root, `content/posts/post-${i}.md`), `---\ntitle: ${title(i)}\n---\n` + post(i, n));
  mkdirSync(join(root, 'node_modules/@tiaforge-ui'), { recursive: true });
  symlinkSync(REPO, join(root, 'node_modules/@tiaforge-ui/sinter'), 'dir');
  symlinkSync(join(REPO, 'packages/sinter-markdown'), join(root, 'node_modules/@tiaforge-ui/sinter-markdown'), 'dir');
}
