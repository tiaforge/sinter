// The prototype's app (docs/proposals/collections.md, part 0): a blog of `n` markdown posts, one template page
// built once per post through `sinter({ prototypePages })`, and an index listing the latest posts.
// `live`: each post also has a live resource (its comments), so each post's page has a module of its own.
import { mkdirSync, rmSync, symlinkSync, writeFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const REPO = resolve(import.meta.dirname, '../..');
const words = 'sinter pages build data markdown list entry static runtime module html layout component slot resource field type check link folder content'.split(' ');
const sentence = (i, j) => Array.from({ length: 12 }, (_, k) => words[(i * 7 + j * 3 + k * 5) % words.length]).join(' ') + '.';
const para = (i, j) => Array.from({ length: 5 }, (_, k) => sentence(i, j * 5 + k)).join(' ');

/** a post of about 600 words: headings, paragraphs, a list, a code block, links */
export const post = (i) => `## Introduction

${para(i, 0)} See [the next post](/blog/post-${(i + 1)}) and *emphasis* with \`code\`.

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

const TEMPLATE = (live) => `<!doctype html>
<html lang="en" data-sn-path="/blog/:slug">
<head><meta charset="utf-8"><title>{=title}</title></head>
<body>
<sn-resource name="post" src="file:/content/posts/{=slug}.md"></sn-resource>
<main data-sn-let="{ doc: md.parse(post) }">
  <h1>{=title}</h1>
  <nav><template data-sn-for="h in md.headings(doc)"><a data-sn-attr="{ href: '#' + h.id }" data-sn-text="h.text"></a></template></nav>
  <md-doc data-sn-prop="{ doc }"></md-doc>
</main>
${live ? `<sn-resource name="comments" src="/api/comments?post={=slug}" items="comments" key="id" type="any"></sn-resource>
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
export function writeApp(root, { n, live }) {
  rmSync(root, { recursive: true, force: true });
  const files = {
    'vite.config.js': `import { resolve } from 'node:path';
import { defineConfig } from 'vite';
import sinter from '@tiaforge-ui/sinter/vite';
const n = ${n};
export default defineConfig({
  logLevel: 'warn',
  plugins: [sinter({
    components: ['@tiaforge-ui/sinter-markdown'],
    site: 'https://example.com',
    prototypePages: { 'blog/post.html': () => Array.from({ length: n }, (_, i) => ({ slug: 'post-' + i, title: 'Post ' + i })) },
  })],
  build: { rollupOptions: { input: { index: resolve(import.meta.dirname, 'index.html'), post: resolve(import.meta.dirname, 'blog/post.html') } } },
});
`,
    'src/sinter.helpers.ts': "export * as md from '@tiaforge-ui/sinter-markdown';\n",
    'src/sinter.types.ts': "export type { Root } from '@tiaforge-ui/sinter-markdown';\n",
    'index.html': INDEX(n),
    'blog/post.html': TEMPLATE(live),
  };
  for (const [f, s] of Object.entries(files)) { mkdirSync(dirname(join(root, f)), { recursive: true }); writeFileSync(join(root, f), s); }
  mkdirSync(join(root, 'content/posts'), { recursive: true });
  for (let i = 0; i < n; i++) writeFileSync(join(root, `content/posts/post-${i}.md`), post(i));
  mkdirSync(join(root, 'node_modules/@tiaforge-ui'), { recursive: true });
  symlinkSync(REPO, join(root, 'node_modules/@tiaforge-ui/sinter'), 'dir');
  symlinkSync(join(REPO, 'packages/sinter-markdown'), join(root, 'node_modules/@tiaforge-ui/sinter-markdown'), 'dir');
}
