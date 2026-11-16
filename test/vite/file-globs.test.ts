// @vitest-environment node
// `file:` globs in a build (docs/resources.md#files), through the project's own listing: a folder of markdown
// posts is a list the page unrolls at build time, sorted, without drafts; `node_modules`, dot-folders and links
// out of the root are not listed; the page ships no JavaScript.
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { build } from 'vite';
import { afterAll, expect, test } from 'vitest';
import sinter from '../../src/vite.js';
import { project } from '../../src/project.js';

const src = resolve(__dirname, '../../src');
const alias = [{ find: /^@tiaforge-ui\/sinter\/(.+)$/, replacement: `${src}/$1.ts` }, { find: /^@tiaforge-ui\/sinter$/, replacement: `${src}/index.ts` }];
const tmp = mkdtempSync(join(tmpdir(), 'sinter-file-globs-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const root = join(tmp, 'app');
const put = (f: string, s: string) => { mkdirSync(join(root, f, '..'), { recursive: true }); writeFileSync(join(root, f), s); };
put('content/posts/hello.md', '---\ntitle: Hello\ndate: 2026-11-02\n---\nHi.\n');
put('content/posts/2026/recap.md', '---\ntitle: Recap\ndate: 2026-12-30\n---\nThe year.\n');
put('content/posts/wip.md', '---\ntitle: Work in progress\ndate: 2026-12-31\ndraft: true\n---\nSoon.\n');
put('content/posts/node_modules/dep.md', '---\ntitle: From a dependency\n---\n');
put('content/posts/.cache/old.md', '---\ntitle: Cached\n---\n');
put('../outside/secret.md', '---\ntitle: Outside\n---\n');
symlinkSync(join(tmp, 'outside/secret.md'), join(root, 'content/posts/secret.md'));
put('index.html', `<!doctype html><html lang="en"><head><title>Blog</title></head><body>
<sn-resource name="posts" src="file:/content/posts/**/*.md" order="-date" drafts="draft"></sn-resource>
<ul><template data-sn-for="p in posts"><li data-sn-text="p.dir + '/' + p.slug + ': ' + p.title"></li></template></ul>
</body></html>`);

test('the project lists a folder: not node_modules, not dot-folders, not a link out of the root', () => {
  const files = project(root).listFiles(join(root, 'content/posts')).map((f) => f.slice(root.length)).sort();
  expect(files).toEqual(['/content/posts/2026/recap.md', '/content/posts/hello.md', '/content/posts/wip.md']);
  expect(() => project(root).listFiles(join(tmp, 'outside'))).toThrow(/outside the project root/);
});

test('a build unrolls the list: sorted, without drafts, and no JavaScript', async () => {
  await build({ root, logLevel: 'silent', plugins: [sinter({ static: true })], resolve: { alias }, build: { outDir: join(root, 'dist'), emptyOutDir: true } });
  const html = readFileSync(join(root, 'dist/index.html'), 'utf8');
  expect([...html.matchAll(/<li>([^<]*)<\/li>/g)].map((m) => m[1])).toEqual(['2026/recap: Recap', '/hello: Hello']);
  expect(readdirSync(join(root, 'dist')).some((f) => f === 'assets')).toBe(false);
}, 60_000);
