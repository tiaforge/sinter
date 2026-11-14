#!/usr/bin/env node
// Builds the docs the `docs` condition puts in every workspace: docs/<framework>.txt, at most CAP characters each.
//   node docs/fetch.mjs
// The rule, the same for every framework (SPEC.md § Conditions):
//   1. the framework's own documentation written for LLMs, as published, when it fits under the cap;
//   2. if it is larger, that file cut at the cap at a page boundary, in its own order;
//   3. a framework that publishes no such file gets none.
// sinter:    llms.txt from the published package (109 KB: it fits).
// SvelteKit: svelte.dev/llms-small.txt, the Svelte team's condensed docs for Svelte and SvelteKit (53 KB). The larger
//            llms-medium.txt (886 KB) cut at the cap would hold only the Svelte runtime and no SvelteKit.
// Astro:     none: it removed its llms files in April 2026 (below).
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

// Astro: nothing. docs.astro.build published llms.txt, llms-small.txt and llms-full.txt until withastro/docs#13538 removed
// them on 2026-04-20 in favour of its Docs MCP server, so the docs condition gives Astro no file, as Astro itself gives
// none (its MCP server is part of the tools condition).
rmSync(join(here, 'astro.txt'), { force: true });
rmSync(work, { recursive: true, force: true });
