// llms.txt and html-custom-data.json are generated from the vocabulary and the
// recipes; this test fails when they are stale. `npm run docs` rewrites them.
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, test } from 'vitest';
import { CODES, severityOf, type Code } from '../src/compiler/diagnostics.js';
import { DIAGNOSTIC_DOCS } from '../src/compiler/diagnostic-docs.js';
import { ALL_MAGIC, BUILTIN_HELPERS, STORE_FNS } from '../src/compiler/expr.js';
import { ATTRIBUTES, ELEMENTS, ON_DOC } from '../src/compiler/vocabulary.js';

const root = resolve(__dirname, '..');
const recipes = resolve(root, 'docs/recipes');
const update = !!process.env.UPDATE_DOCS;

// [file, title, extra files shown before the test]
const RECIPES: Array<[string, string, string[]?]> = [
  ['list-filter', 'List with filter'],
  ['form-dialog', 'Form dialog with repeatable fields'],
  ['sse-sync', 'SSE sync'],
  ['optimistic-toggle', 'Optimistic toggle'],
  ['pagination', 'Pagination'],
  ['signalr', 'SignalR (or another transport) for <sn-sync>', ['signalr-transport.js']],
  ['typed', 'Typed resources, state and events', ['typed.types.ts']],
  ['cached-list', 'Cached list across page loads'],
];

function llms(): string {
  const out: string[] = [];
  out.push(`# sinter

> sinter binds JSON APIs to plain HTML: keyed resources cached from the server, kept current from server events, rendered through <template> bindings, with optimistic mutations. A build step compiles annotated HTML into a page module; the browser runs no parser and no eval.

Package: @tiaforge/sinter. Every directive is a \`data-sn-*\` attribute or an \`<sn-*>\` element. Anything else is a build error with a suggestion.

## Attributes
`);
  for (const a of [...ATTRIBUTES, ON_DOC]) out.push(`- \`data-sn-${a.name}\`${a.value ? ` (${a.value})` : ''}: ${a.doc}`);
  out.push('\n## Elements\n');
  for (const e of ELEMENTS) out.push(`- \`<${e.name}>\` ${e.attrs.map((x) => `\`${x}\``).join(', ')}: ${e.doc}`);
  out.push(`
## Expressions and scope

- Attribute values are JavaScript expressions, checked at build time. Value expressions (text, attr, class, show, for, if, key, body, state, URL interpolations) cannot assign, use \`++\`, \`delete\`, \`await\` or \`import()\`.
- Handlers (\`data-sn-on-*\`, \`then\`, \`catch\`) are statements separated by \`;\`: assignments to state, \`$url.<param>\` and \`$locale\`, and calls. No declarations or loops.
- \`data-sn-optimistic\` may only call \`patch\`, \`upsert\`, \`remove\`.
- A name resolves innermost first: loop variables, then the nearest \`data-sn-state\`, then resources, then magic names, helpers and store functions, then JavaScript globals. Browser APIs (\`window\`, \`document\`, \`fetch\`, timers, …) are refused: use an island.
- Resources are read-only: copy an item with \`structuredClone(c)\` to edit it, write with \`patch()\`.
- Helpers are plain function calls, never pipes: ${BUILTIN_HELPERS.map((h) => `\`${h}()\``).join(', ')}. Helper namespaces: \`m.inbox_title()\`.
- URL templates: \`/api/x?id={c.id}\`; interpolations are URL-encoded; the template must start with a literal \`/path\` or \`https://origin\`.
- Use \`$now\` instead of \`Date.now()\` so bindings update.

## Magic names

${ALL_MAGIC.map((m) => `\`${m}\``).join(', ')}. \`$event\` in handlers, \`$result\` in \`then\`, \`$error\` (\`{status, body, message}\`) in \`catch\`; \`$meta.<resource>\` has \`loading\`, \`error\`, \`loadedAt\`, \`pending\`, \`total\`, and with \`paginate\`: \`page\` (offset), \`pages\`, \`from\`, \`to\`, \`hasPrev\`, \`hasNext\`.

## Store functions

${STORE_FNS.map((f) => `\`${f}()\``).join(', ')}: \`refresh('name')\`, \`upsert('name', item)\`, \`patch('name', item, {…})\`, \`remove('name', item)\`, \`page('name', 'next' | 'prev' | 'first' | 'last' | n)\`, \`close()\` the nearest dialog, \`reset()\` the nearest form, \`emit('event', detail)\`.

## Diagnostics

${Object.entries(CODES).map(([c, n]) => `\`${c} ${n}\``).join(', ')}.

## Recipes

Each recipe comes with its test; copy both.
`);
  for (const [file, title, extra = []] of RECIPES) {
    out.push(`### ${title}\n`);
    out.push('```html\n' + readFileSync(`${recipes}/${file}.html`, 'utf8').trim() + '\n```\n');
    for (const x of extra) out.push('```' + (x.endsWith('.ts') ? 'ts' : 'js') + '\n' + readFileSync(`${recipes}/${x}`, 'utf8').trim() + '\n```\n');
    out.push('```ts\n' + readFileSync(`${recipes}/${file}.test.ts`, 'utf8').trim() + '\n```\n');
  }
  out.push(`## Type checking

\`npx sinter check\` type-checks every expression with the project's TypeScript (pages and options come from the Vite config). \`sinter({ typecheck: true })\` runs it in \`vite build\`.

- \`<sn-resource … type="Contact[]">\`: the type of what \`items\` selects, using names exported by \`src/sinter.types.ts\`. \`type="any"\` opts out; no \`type\` is warning SN504.
- \`sinter({ openapi: 'openapi.yml' })\`: resources without \`type\` are matched to a GET operation by \`src\` (server prefix stripped, \`{…}\` matches a path parameter) and typed from its JSON response at \`items\`. Every build then checks \`items\`/\`total\` against the schema (SN308) and query parameter names (SN505).
- State takes a JSDoc cast where the literal is not enough: \`data-sn-state="{ editing: /** @type {Contact|null} */ (null) }"\`.
- Actions matched in the spec: \`data-sn-body\` is checked against the request schema, \`$result\` in \`then\` has the response type.
- \`<sn-event … type="ContactEvent">\` types the payload; \`item\` must fit the resource's item, \`set\` part of it; \`cursor\` reads the item. No \`type\` on an event with payload expressions is warning SN506.
- Errors are SN208 at the HTML position, with TypeScript's message. Null checks are off. In tests: \`checkPage(html, { files, openapi })\` from \`@tiaforge/sinter/check\`.
`);
  out.push(`## Deploying streams

Each open EventSource holds one HTTP connection, and HTTP/1.1 allows 6 per origin: with more than 5 tabs open, pages stop loading. Serve streams over HTTP/2 (any TLS reverse proxy such as nginx or Caddy) or use the WebSocket transport; dev builds warn about HTTP/1.1.
`);
  out.push(`## Editors

\`npx sinter lsp --stdio\` is a language server for the project's HTML files: sinter's diagnostics as you type (partials checked through the pages that include them), and with TypeScript 7 type errors, hover, completion in expressions, go to definition and a did-you-mean quick fix. VS Code: the extension in \`editors/vscode\`. Setup for Neovim, Helix and Emacs: \`docs/editors.md\`. Every diagnostic links to its explanation in \`docs/diagnostics.md\`.
`);
  out.push(`## Testing

Write a test next to the markup. \`@tiaforge/sinter/testing\` compiles the page with the real compiler and mounts it:

- \`render(html, { requests, streams, url, locale, now, helpers, files, storage, session })\` → \`{ root, app, flush, settle, advance, navigations, window }\`. Pass one \`memoryStorage()\` as \`session\` to two renders to test what carries over between page loads (the \`cache\` attribute).
- \`mockRequests({ 'GET /api/x': json | {status, body} | (call) => … })\`: records \`calls\`; responses are held until \`settle()\`; an unmatched request fails the test and lists the routes.
- \`mockStream()\`: \`emit(name, payload)\`, \`drop()\`, \`connected\`. A stream URL with no mock uses the transport from \`configure({ transport })\`, so a custom transport can be tested over a fake connection (see the SignalR recipe).
- \`flush()\` runs the scheduler (optimistic changes are visible), \`settle()\` finishes requests, queues and debounces, \`advance(ms)\` moves sinter's clock.
`);
  return out.join('\n');
}

function diagnostics(): string {
  const out = [`# sinter diagnostics

Generated from \`src/compiler/diagnostic-docs.ts\` by \`npm run docs\`. Every diagnostic links to its section here. Codes from SN500 up are warnings; the rest are errors and fail the build.
`];
  for (const [code, name] of Object.entries(CODES)) {
    const d = DIAGNOSTIC_DOCS[code as Code];
    out.push(`## ${code} ${name}\n\n${severityOf(code as Code) === 'error' ? 'Error' : 'Warning'}, for example:\n\n> ${d.example}\n\n${d.means}\n\n**Fix:** ${d.fix}\n`);
  }
  return out.join('\n');
}

function customData(): string {
  const data = {
    version: 1.1,
    tags: ELEMENTS.map((e) => ({
      name: e.name,
      description: e.doc,
      attributes: e.attrs.map((a) => ({ name: a })),
    })),
    globalAttributes: [
      ...ATTRIBUTES.map((a) => ({ name: `data-sn-${a.name}`, description: `${a.doc}${a.value ? ` (${a.value})` : ''}` })),
      ...['click', 'input', 'change', 'submit', 'keydown'].map((e) => ({ name: `data-sn-on-${e}`, description: ON_DOC.doc })),
    ],
  };
  return JSON.stringify(data, null, 2) + '\n';
}

function check(path: string, content: string) {
  const file = resolve(root, path);
  if (update) { writeFileSync(file, content); return; }
  let current = '';
  try { current = readFileSync(file, 'utf8'); } catch { /* missing */ }
  expect(current, `${path} is stale: run \`npm run docs\``).toBe(content);
}

test('llms.txt is current', () => check('llms.txt', llms()));
test('docs/diagnostics.md is current', () => check('docs/diagnostics.md', diagnostics()));
test('html-custom-data.json is current', () => check('html-custom-data.json', customData()));
test('the VS Code extension\'s custom data is current', () => check('editors/vscode/html-custom-data.json', customData()));
test('every recipe has a test', () => {
  const html = readdirSync(recipes).filter((f) => f.endsWith('.html')).map((f) => f.replace(/\.html$/, ''));
  expect(html.sort()).toEqual(RECIPES.map((r) => r[0]).sort());
  for (const r of html) expect(readdirSync(recipes)).toContain(`${r}.test.ts`);
});
