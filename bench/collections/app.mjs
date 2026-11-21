// The benchmark's app (docs/proposals/collections.md, Prototype): a blog of `n` markdown posts and an index. By default
// one template page builds every post (`data-sn-for` on `<html>`); with `pages: false` (`measure.mjs --files`) each post is a page
// of its own, reading its file, which compiles the same way. `live`: each post also has a live resource (its
// comments), so each post's page has a module of its own.
import { mkdirSync, rmSync, symlinkSync, writeFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const REPO = resolve(import.meta.dirname, '../..');
const words = 'sinter pages build data markdown list entry static runtime module html layout component slot resource field type check link folder content'.split(' ');
const sentence = (i, j) => Array.from({ length: 12 }, (_, k) => words[(i * 7 + j * 3 + k * 5) % words.length]).join(' ') + '.';
const para = (i, j) => Array.from({ length: 5 }, (_, k) => sentence(i, j * 5 + k)).join(' ');

/** a post of about 600 words: headings, paragraphs, a list, a code block, links */
export const post = (i, n) => `## Introduction

${para(i, 0)} See [the next post](/blog/post-${(i + 1) % n}) and *emphasis* with \`code\`.

${para(i, 1)}

## Details

- ${sentence(i, 20)}
- ${sentence(i, 21)} [a link](https://example.com/${i})
- ${sentence(i, 22)}

\`\`\`js
console.log(${i});
\`\`\`

${para(i, 2)}

### More

${para(i, 3)}

${para(i, 4)}
`;

/** a post's page: written once per post (`files`), or the template every post is built from (`data-sn-for` on `<html>`) */
const PAGE = (live, src, attrs, slug) => `<!doctype html>
<html lang="en"${attrs}>
<head><meta charset="utf-8"><title data-sn-text="post.title"></title></head>
<body>
${src}
<main data-sn-let="{ doc: md.parse(post.body) }">
  <h1 data-sn-text="post.title"></h1>
  <nav><template data-sn-for="h in md.headings(doc)"><a data-sn-attr="{ href: '#' + h.id }" data-sn-text="h.text"></a></template></nav>
  <md-doc data-sn-with="{ doc }"></md-doc>
</main>
${live ? `<sn-resource name="comments" src="/api/comments?post={${slug}}" select="comments" key="id" type="any"></sn-resource>
<ul><template data-sn-for="c in comments"><li data-sn-text="c.body"></li></template></ul>` : ''}
</body>
</html>
`;

const INDEX = (n) => `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Blog</title></head>
<body>
<ul>
${Array.from({ length: Math.min(n, 20) }, (_, i) => `  <li><a href="/blog/post-${n - 1 - i}">Post ${n - 1 - i}</a></li>`).join('\n')}
</ul>
</body>
</html>
`;

/** writes the app into `root`, replacing what is there */
/** `pages`: one template with `data-sn-for` on `<html>`; else one page per post, each reading its own file */
export function writeApp(root, { n, live, pages = true }) {
  rmSync(root, { recursive: true, force: true });
  const files = {
    'vite.config.js': `import { resolve } from 'node:path';
import { defineConfig } from 'vite';
import sinter from '@tiaforge-ui/sinter/vite';
const n = ${n};
export default defineConfig({
  logLevel: 'warn',
  plugins: [sinter({
    libraries: ['@tiaforge-ui/sinter-markdown'],
    site: 'https://example.com',
  })],
  build: { rollupOptions: { input: Object.fromEntries([['index', resolve(import.meta.dirname, 'index.html')], ...(${pages} ? [['post', resolve(import.meta.dirname, 'blog/post.html')]] : Array.from({ length: n }, (_, i) => ['post-' + i, resolve(import.meta.dirname, 'blog/post-' + i + '.html')]))]) } },
});
`,
    'src/sinter.helpers.ts': "export * as md from '@tiaforge-ui/sinter-markdown';\n",
    'src/sinter.types.ts': "export type { Root } from '@tiaforge-ui/sinter-markdown';\n",
    'index.html': INDEX(n),
  };
  if (pages) files['blog/post.html'] = PAGE(live, '<sn-resource name="posts" src="file:/content/posts/*.md"></sn-resource>', ' data-sn-path="/blog/:slug" data-sn-for="post in posts"', 'post.slug');
  else for (let i = 0; i < n; i++) files[`blog/post-${i}.html`] = PAGE(live, `<sn-resource name="post" src="file:/content/posts/post-${i}.md"></sn-resource>`, '', `'post-${i}'`);
  for (const [f, s] of Object.entries(files)) { mkdirSync(dirname(join(root, f)), { recursive: true }); writeFileSync(join(root, f), s); }
  mkdirSync(join(root, 'content/posts'), { recursive: true });
  for (let i = 0; i < n; i++) writeFileSync(join(root, `content/posts/post-${i}.md`), `---\ntitle: Post ${i}\n---\n` + post(i, n));
  mkdirSync(join(root, 'node_modules/@tiaforge-ui'), { recursive: true });
  symlinkSync(REPO, join(root, 'node_modules/@tiaforge-ui/sinter'), 'dir');
  symlinkSync(join(REPO, 'packages/sinter-markdown'), join(root, 'node_modules/@tiaforge-ui/sinter-markdown'), 'dir');
}
