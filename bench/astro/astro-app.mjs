// The Astro site (README.md): the same posts as a content collection, one page per post from `[slug].astro`.
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { post, title } from './content.mjs';

export function writeAstroApp(root, { n }) {
  rmSync(join(root, 'src'), { recursive: true, force: true });
  rmSync(join(root, 'dist'), { recursive: true, force: true });
  const out = {
    'package.json': JSON.stringify({ name: 'bench-astro', private: true, type: 'module', dependencies: { astro: 'latest' } }, null, 2) + '\n',
    'astro.config.mjs': "import { defineConfig } from 'astro/config';\nexport default defineConfig({ site: 'https://example.com', logLevel: 'warn' });\n",
    'src/content.config.ts': `import { defineCollection, z } from 'astro:content';
import { glob } from 'astro/loaders';
export const collections = { posts: defineCollection({ loader: glob({ pattern: '*.md', base: './src/content/posts' }), schema: z.object({ title: z.string() }) }) };
`,
    'src/pages/blog/[slug].astro': `---
import { getCollection, render } from 'astro:content';
export async function getStaticPaths() {
  return (await getCollection('posts')).map((post) => ({ params: { slug: post.id }, props: { post } }));
}
const { post } = Astro.props;
const { Content } = await render(post);
---
<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>{post.data.title}</title></head>
<body>
<main>
  <h1>{post.data.title}</h1>
  <Content />
</main>
</body>
</html>
`,
    'src/pages/index.astro': `---
import { getCollection } from 'astro:content';
const posts = await getCollection('posts');
---
<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Blog</title></head>
<body>
<ul>
{posts.map((p) => <li><a href={'/blog/' + p.id + '/'}>{p.data.title}</a></li>)}
</ul>
</body>
</html>
`,
  };
  for (const [f, s] of Object.entries(out)) { mkdirSync(dirname(join(root, f)), { recursive: true }); writeFileSync(join(root, f), s); }
  for (let i = 0; i < n; i++) { const f = join(root, `src/content/posts/post-${i}.md`); mkdirSync(dirname(f), { recursive: true }); writeFileSync(f, `---\ntitle: ${title(i)}\n---\n` + post(i, n)); }
}
