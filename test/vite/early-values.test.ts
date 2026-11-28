// @vitest-environment node
// A built page whose state has a field a helper computed at build time (written into the page, `$.$d(id)`): the early
// script makes the state as it starts, so the value must be parsed by then. The build writes the values the early file
// reads before the head scripts. Checked on the built files themselves: jsdom parses the page and runs its classic
// head scripts where they stand, as a browser does (the page module, a module script, does not run: the first paint).
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { build } from 'vite';
import { afterAll, expect, test } from 'vitest';
import sinter from '../../src/vite.js';

// (jsdom ships no types: what this test uses of it)
type Dom = { window: Window & typeof globalThis };
const { JSDOM } = createRequire(import.meta.url)('jsdom') as { JSDOM: new (html: string, options: { url: string; runScripts: 'dangerously'; pretendToBeVisual: boolean; beforeParse(window: Dom['window']): void }) => Dom };

const src = resolve(__dirname, '../../src');
const alias = [{ find: /^@tiaforge-ui\/sinter\/runtime$/, replacement: `${src}/runtime-entry.ts` }, { find: /^@tiaforge-ui\/sinter\/(?:runtime\/)?([\w-]+)$/, replacement: `${src}/$1.ts` }, { find: /^@tiaforge-ui\/sinter$/, replacement: `${src}/index.ts` }];
const tmp = mkdtempSync(join(tmpdir(), 'sinter-early-values-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const HELPERS = 'export const titled = (s: string): string => s.replace(/\\b\\w/g, (c) => c.toUpperCase());\n';
// `title` is computed at build time (and changed by a click, so it is read where it is shown); `done` starts true (its
// branch closed, its else shown); `pinned` is a stored choice
const PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>t</title></head><body>
<main data-sn-state="{ pinned: false, done: true, title: titled('hello world') }">
  <input id="pin" type="checkbox" data-sn-model="pinned" data-sn-persist="pinned"><button data-sn-on-click="done = !done; title = title + '!'">t</button>
  <template data-sn-if="!done"><p id="todo">to do</p></template><template data-sn-else><p id="fine">done</p></template>
  <template data-sn-if="!done"><p id="todo2">to do</p></template>
  <template data-sn-if="pinned"><h1 data-sn-text="title"></h1></template>
</main></body></html>
`;

async function site(name: string, options: Parameters<typeof sinter>[0] = {}) {
  const root = join(tmp, name), out = join(root, 'dist');
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(join(root, 'src/sinter.helpers.ts'), HELPERS);
  writeFileSync(join(root, 'index.html'), PAGE);
  await build({ root, logLevel: 'silent', resolve: { alias }, plugins: [sinter(options)], build: { outDir: out, emptyOutDir: true, rollupOptions: { input: { index: join(root, 'index.html') } } } });
  return { out, html: readFileSync(join(out, 'index.html'), 'utf8') };
}

/**
 * The built page parsed with its head scripts run where they stand, the stored values given: the document at
 * DOMContentLoaded. The scripts' code is written into their tags, as jsdom runs an inline classic script when the parser
 * reaches it, with only what is before it parsed (an external one it would run after the whole parse).
 */
async function firstPaint(out: string, html: string, stored: Record<string, string>) {
  const errors: string[] = [];
  const inlined = html.replace(/<script src="(\/assets\/[^"]+)"><\/script>/g, (_, src: string) => `<script>${readFileSync(join(out, src), 'utf8').replace(/<\/script/gi, '<\\/script')}</script>`);
  expect(inlined).not.toBe(html);
  const dom = new JSDOM(inlined, {
    url: 'http://localhost/', runScripts: 'dangerously', pretendToBeVisual: true,
    beforeParse(window) {
      for (const [k, v] of Object.entries(stored)) window.localStorage.setItem(k, v);
      window.addEventListener('error', (e) => errors.push(String(e.message)));
    },
  });
  if (dom.window.document.readyState == 'loading') await new Promise((ok) => dom.window.document.addEventListener('DOMContentLoaded', ok));
  // (the early script's last pass is its own DOMContentLoaded listener)
  await new Promise((ok) => setTimeout(ok, 0));
  return { document: dom.window.document, errors };
}

test('the values the early file reads are in the head before the head scripts, and the first paint has the state they are part of', async () => {
  const { out, html } = await site('values');
  // a first visit: the branch over `done` is closed and its else shown, the stored choice off
  const fresh = await firstPaint(out, html, {});
  expect(fresh.errors).toEqual([]);
  expect([!!fresh.document.querySelector('#todo'), !!fresh.document.querySelector('#fine'), !!fresh.document.querySelector('#todo2'), !!fresh.document.querySelector('h1')]).toEqual([false, true, false, false]);
  // with the stored choice: the build's value is shown, and nothing is painted that the page module would take out again
  const stored = await firstPaint(out, html, { 'sn:pinned': 'true' });
  expect(stored.errors).toEqual([]);
  expect(stored.document.querySelector('h1')?.textContent).toBe('Hello World');
  expect((stored.document.querySelector('#pin') as HTMLInputElement).checked).toBe(true);
  expect([!!stored.document.querySelector('#todo'), !!stored.document.querySelector('#fine'), !!stored.document.querySelector('#todo2')]).toEqual([false, true, false]);  // where the build put it: in the head, before the head scripts
  const head = html.slice(0, html.indexOf('</head>'));
  const value = /<script type="application\/json" data-sn="\d+">"Hello World"<\/script>/.exec(head);
  expect(value).not.toBeNull();
  expect(value!.index).toBeLessThan(head.indexOf('<script src='));
});

test('with the HTML left as written (`minifyHtml: false`) the values are placed the same', async () => {
  const { out, html } = await site('plain', { minifyHtml: false });
  expect(html.indexOf('"Hello World"</script>')).toBeLessThan(html.indexOf('<script src='));
  const stored = await firstPaint(out, html, { 'sn:pinned': 'true' });
  expect(stored.document.querySelector('h1')?.textContent).toBe('Hello World');
  expect(!!stored.document.querySelector('#todo')).toBe(false);
});
