#!/usr/bin/env node
// Builds the docs the `docs` condition puts in every workspace: docs/<framework>.txt, at most CAP characters each.
//   node docs/fetch.mjs
// The rule, the same for every framework (SPEC.md § Conditions):
//   1. the framework's own documentation written for LLMs, as published, when it fits under the cap;
//   2. otherwise its documentation site's pages, chosen round robin over the site's navigation groups (the first page
//      of each group, then the second, …), whole pages until the cap, written in the site's order.
// sinter:    llms.txt from the published package (109 KB: it fits).
// SvelteKit: svelte.dev/llms-small.txt, the Svelte team's condensed docs for Svelte and SvelteKit (53 KB). The larger
//            llms-medium.txt (886 KB) cut at the cap would hold only the Svelte runtime and no SvelteKit.
// Astro:     its llms-small.txt, rebuilt (below: it was removed from docs.astro.build in April 2026), cut at the cap.
// (Earlier draft of this rule, kept for the record: withastro/docs (MIT), the
//            Guides tab of astro.sidebar.ts by rule 2, then the Reference tab with what is left. (In plain sidebar order the cap is
//            reached after 10 pages of setup and configuration, before routing or components.) Upgrade guides, recipes,
//            migration guides, the courses page and the contributing page are left out (not about building with Astro).
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const CAP = 200_000; // characters, about 50k tokens: a maximum, not a quota (sinter's llms.txt is 109 KB, Svelte's 53 KB)
const here = new URL('.', import.meta.url).pathname;
const work = mkdtempSync(join(tmpdir(), 'bench-docs-'));
const sh = (cmd, args, cwd = work) => execFileSync(cmd, args, { cwd, stdio: ['ignore', 'pipe', 'inherit'] }).toString();
const header = (fw, src) => `<!-- ${fw} documentation for the agent benchmark (bench/llm/docs/fetch.mjs). Source: ${src}. -->\n\n`;
const write = (fw, src, text) => {
  const out = header(fw, src) + text;
  if (out.length > CAP) throw new Error(`${fw}: ${out.length} characters, over the cap`);
  writeFileSync(join(here, `${fw}.txt`), out);
  console.log(`${fw}: ${out.length} characters (~${Math.round(out.length / 4000)}k tokens)`);
};

// sinter
const version = sh('npm', ['view', '@tiaforge-ui/sinter', 'version']).trim();
sh('npm', ['pack', `@tiaforge-ui/sinter@${version}`, '--silent']);
sh('tar', ['xzf', `tiaforge-ui-sinter-${version}.tgz`, 'package/llms.txt']);
write('sinter', `@tiaforge-ui/sinter@${version}, llms.txt`, readFileSync(join(work, 'package/llms.txt'), 'utf8'));

// SvelteKit
const svelte = sh('curl', ['-sSfL', 'https://svelte.dev/llms-small.txt']); // curl: it goes through the HTTPS proxy, Node's fetch does not
write('sveltekit', `https://svelte.dev/llms-small.txt, ${new Date().toISOString().slice(0, 10)}`, svelte);

// Astro: its own abridged docs (llms-small.txt), rebuilt. docs.astro.build generated it with starlight-llms-txt until
// withastro/docs#13538 removed it on 2026-04-20; the settings below are that last configuration
// (config/plugins/llms-txt.ts at 21214cc3^), applied the way starlight-llms-txt 0.8 does: English pages that are not
// drafts, minus `exclude`; `promote` first, the rest in alphabetical order of their id (Intl.Collator('en')); each page
// `# title`, `> description`, then the body without note and tip asides and without <details> (its `minify` defaults).
// One difference: the plugin rendered each page and turned the HTML back into Markdown; this works on the MDX source,
// dropping imports and lines that are only a component tag, and keeping the text inside components.
sh('git', ['clone', '-q', '--depth', '1', 'https://github.com/withastro/docs.git', 'astro']);
const dir = join(work, 'astro'), commit = sh('git', ['rev-parse', '--short', 'HEAD'], dir).trim();
const PROMOTE = ['en/concepts/why-astro', 'en/concepts/islands', 'en/install-and-setup', 'en/basics/project-structure', 'en/develop-and-build', 'en/guides/configuring-astro'];
const EXCLUDE = ['en/getting-started', 'en/contribute', 'en/reference/legacy-flags', 'en/guides/upgrade-to/v{1..4}', 'en/recipes/**', 'en/tutorial/**',
  'en/reference/**', 'en/guides/imports', 'en/guides/backend/**', 'en/guides/cms/**', 'en/guides/deploy/**', 'en/guides/migrate-to-astro/**',
  'en/guides/ecommerce', 'en/guides/authentication', 'en/guides/testing', 'en/guides/media/**'];
const glob = (g) => new RegExp('^' + g.replace(/\{(\d+)\.\.(\d+)\}/g, (_, a, b) => `(${Array.from({ length: b - a + 1 }, (_, i) => +a + i).join('|')})`)
  .replace(/\/\*\*/g, '\0').replace(/\*/g, '[^/]*').replace(/\0/g, '(/.*)?') + '$'); // `a/**` matches `a` too, as in micromatch
const excluded = EXCLUDE.map(glob), promoted = PROMOTE.map(glob);
const root = join(dir, 'src/content/docs');
const ids = sh('find', ['en', '-name', '*.md', '-o', '-name', '*.mdx'], root).trim().split('\n').map((f) => f.replace(/\.mdx?$/, '').replace(/\/index$/, ''));
const collator = new Intl.Collator('en');
const rank = (id) => { const i = promoted.findIndex((r) => r.test(id)); return '_'.repeat(i > -1 ? PROMOTE.length - i : 0) + id; };
const pages = ids.filter((id) => !excluded.some((r) => r.test(id))).sort((a, b) => collator.compare(rank(a), rank(b))).map((id) => {
  const f = ['.mdx', '.md', '/index.mdx', '/index.md'].map((x) => join(root, id + x)).find(existsSync);
  const src = readFileSync(f, 'utf8'), fm = src.match(/^---\n([\s\S]*?)\n---\n/)?.[1] ?? '';
  if (/^draft:\s*true/m.test(fm)) return null;
  const field = (k) => fm.match(new RegExp(`^${k}:\\s*(.+)$`, 'm'))?.[1].trim().replace(/^['"]|['"]$/g, '');
  const body = src.slice(fm ? src.indexOf('\n---\n', 4) + 5 : 0)
    .replace(/^:::(note|tip)[^\n]*\n[\s\S]*?^:::\s*$/gm, '') // note and tip asides
    .replace(/<details[\s\S]*?<\/details>/g, '')
    .split('\n').filter((l) => !/^import\s.+from\s/.test(l) && !/^\s*<\/?[A-Z][\w.]*(\s[^>]*)?\/?>\s*$/.test(l)).join('\n')
    .replace(/\n{3,}/g, '\n\n').trim();
  return { id, text: [`# ${field('title') ?? id}`, field('description') && `> ${field('description')}`, body].filter(Boolean).join('\n\n') };
}).filter(Boolean);
const full = pages.map((p) => p.text).join('\n\n');
const SYSTEM = '<SYSTEM>This is the abridged developer documentation for Astro</SYSTEM>\n\n';
let astro = SYSTEM, used = 0;
for (const p of pages) { if (astro.length + p.text.length + 2 > CAP - 1000) break; astro += p.text + '\n\n'; used++; } // whole pages, in order
write('astro', `withastro/docs@${commit} (MIT): Astro's llms-small.txt rebuilt with its last configuration (${Math.round(full.length / 1000)} KB, ${pages.length} pages), cut at the cap after ${used} pages, the last ${pages[used - 1].id}`, astro);
rmSync(work, { recursive: true, force: true });
