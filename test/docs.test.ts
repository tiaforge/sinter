// llms.txt and html-custom-data.json are generated from the vocabulary and the
// recipes; this test fails when they are stale. `npm run docs` rewrites them.
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, test } from 'vitest';
import { CODES, severityOf, type Code } from '../src/compiler/diagnostics.js';
import { DIAGNOSTIC_DOCS } from '../src/compiler/diagnostic-docs.js';
import { ALL_MAGIC, BUILTIN_HELPERS, STORE_FNS } from '../src/compiler/expr.js';
import { ATTRIBUTES, CHAR_KEYS, DEBOUNCE_ON_DOC, ELEMENTS, KEY_ON_DOC, MODIFIERS, NAMED_KEYS, ON_DOC } from '../src/compiler/vocabulary.js';

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
  ['local-actions', 'Local actions: hash a file, then upload it', ['local-actions.actions.js']],
  ['keyboard-shortcuts', 'Keyboard shortcuts'],
  ['row-select', 'Row selection with Ctrl and Shift: logic in a helper, applied by the handler', ['row-select.helpers.js']],
  ['run-action', 'Run an action from a handler: mark a mail read once its body has loaded, and a shortcut'],
  ['first-paint', 'First paint: page chrome that renders before the script'],
  ['messages', 'Messages: m.key() from the inlang files, switching without a reload'],
];

function llms(): string {
  const out: string[] = [];
  out.push(`# sinter

> sinter binds JSON APIs to plain HTML: keyed resources cached from the server, kept current from server events, rendered through <template> bindings, with optimistic mutations. A build step compiles annotated HTML into a page module; the browser runs no parser and no eval.

Package: @tiaforge-ui/sinter. Every directive is a \`data-sn-*\` attribute or an \`<sn-*>\` element. Anything else is a build error with a suggestion.

## Attributes
`);
  for (const a of [...ATTRIBUTES, ON_DOC, KEY_ON_DOC, DEBOUNCE_ON_DOC]) out.push(`- \`data-sn-${a.name}\`${a.value ? ` (${a.value})` : ''}: ${a.doc}`);
  out.push(`
Key filters (\`data-sn-on-keydown-<modifiers->key\`, \`data-sn-on-keyup-…\`): modifiers ${Object.keys(MODIFIERS).map((m) => `\`${m}\``).join(', ')}, then one key: \`a\`–\`z\`, \`0\`–\`9\`, ${Object.keys(NAMED_KEYS).filter((k) => !/^f\d/.test(k)).map((k) => `\`${k}\``).join(', ')}, \`f1\`–\`f12\`, and characters by name: ${Object.entries(CHAR_KEYS).map(([n, c]) => `\`${n}\` (${c === '`' ? '``` ` ```' : `\`${c}\``})`).join(', ')}. Attribute names are lowercase, so N is \`shift-n\`; Shift is not checked for characters (\`question\` is ? however it is typed). Filters on an ancestor skip keys typed into fields (input, textarea, select, contenteditable) and Enter/Space on buttons and links; a filter on the field itself runs. A match calls \`preventDefault()\`; on one element, filters and a plain \`data-sn-on-keydown\` run in attribute order. The nearest element that handles an event wins: for clicks and other native events any handler or action that ran, for keys a matching filter, an action, a debounced handler, or a plain handler that called \`$event.preventDefault()\`; a key a plain handler does not prevent goes on to its ancestors, so a grid's arrow-key handler that prevents only the arrows leaves N to \`<body data-sn-on-keydown-shift-n>\`. Page-wide shortcuts go on \`<body>\`. Bubbling custom events (\`emit()\`, islands' \`CustomEvent\`s, \`sn-error\`, \`dismiss\`) are notifications: every element from the target up with a handler for one runs, inner first, until a handler calls \`$event.preventDefault()\` (the rest of that element's handlers and its action still run); \`emit()\` and \`dismiss\` are cancelable, and an island makes its events stoppable with \`cancelable: true\`. Debounced handlers and actions pass them on. A custom event that does not bubble, and a plain \`Event\`, go to the nearest element only. There is no \`stop()\`; \`stopPropagation()\` does not end the walk.`);
  out.push('\n## Elements\n');
  for (const e of ELEMENTS) out.push(`- \`<${e.name}>\` ${e.attrs.map((x) => `\`${x}\``).join(', ')}: ${e.doc}`);
  out.push(`
## Expressions and scope

- Attribute values are JavaScript expressions, checked at build time. Value expressions (text, attr, class, show, for, if, key, body, state, URL interpolations) cannot assign, use \`++\`, \`delete\`, \`await\` or \`import()\`.
- Handlers (\`data-sn-on-*\`, \`then\`, \`catch\`) are statements separated by \`;\`: assignments to state, \`$url.<param>\` and \`$locale\`, and calls. No declarations or loops.
- A handler cannot call an action function (SN203). To start an action from a handler (a key filter, \`data-sn-then\`, \`<sn-resource then>\`), give the action element an \`id\` and call \`run('id')\`; the element's busy state, concurrency, optimistic layer and \`then\`/\`catch\` apply. A hidden carrier works: \`<span hidden id="mark-read" data-sn-call="mail.markRead(open)"></span>\`. See the recipe "Run an action from a handler".
- \`then\` on \`<sn-event>\` is a handler run after the event's change is applied: payload fields are bare names, the state around the \`<sn-sync>\` is in scope and assignable, and so are its \`data-sn-let\` names (read-only; state and lets win over payload fields of the same name), store functions work (\`close('id')\` names its dialog: there is no element). With \`then\`, \`resource\` and \`op\` may be left out.
- \`then\` on \`<sn-resource>\` is a handler run after each successful load (first load, \`refresh()\`, refetch events, \`src\` changes, every \`page()\`; per source for \`each\`), not for cached data shown at once, failed loads or optimistic/event changes. \`$result\` is what the load stored (what \`items\` selects; the page just loaded). The state around the resource is in scope and assignable; \`close('id')\` names its dialog. It runs on every refetch, so a once-only handler guards itself, one step per guard: \`then="draft = $result ?? draft; $result && showModal('compose')"\`.
- \`data-sn-optimistic\` may only call \`patch\`, \`upsert\`, \`remove\`. The change shows at once, stays when the request succeeds (committed under what \`then\` writes) and is rolled back when it fails.
- A name resolves innermost first: loop variables, then the nearest \`data-sn-state\`, then resources, then magic names, helpers and store functions, then JavaScript globals. Browser APIs (\`window\`, \`document\`, \`fetch\`, timers, …) are refused: use an island.
- Resources are read-only: copy an item with \`structuredClone(c)\` to edit it, write with \`patch()\`.
- Helpers are plain function calls, never pipes: ${BUILTIN_HELPERS.map((h) => `\`${h}()\``).join(', ')}. Helper namespaces: \`m.inbox_title()\`.
- URL templates: \`/api/x?id={c.id}\`; interpolations are URL-encoded; the template must start with a literal \`/path\` or \`https://origin\`. A whole query value that is \`null\`/\`undefined\` or an empty array leaves the parameter out; an array is a repeated key (\`?cal={cals}\` → \`cal=a&cal=b\`); an array in the path is refused.
- Use \`$now\` instead of \`Date.now()\` so bindings update.

## What belongs in markup

- Markup holds filters, conditions, single assignments and short calls. Logic goes into a helper when it computes a value (pure: unit-test it without a page), or into an action when it has side effects (\`data-sn-call\`).
- Handlers apply a helper's result to state: \`data-sn-on-click="sel = rowClick($event, sel, f.id, ids)"\`, not branches on \`$event.shiftKey\` in the attribute. See the row selection recipe.
- One step per condition: \`open && close('detail')\` is fine; \`a && (b = null, close())\` is not: split it into statements, let the dialog's \`data-sn-on-close\` reset state, or compute the new state in a helper.
- Warning SN507 (\`complex-expression\`) flags expressions that outgrew markup and names the limit: statements per handler (4), comma sequences (0), steps behind one \`&&\`/\`||\`/\`?:\` statement (1), \`?:\` nesting (2), operations in an arrow function (8), operations per expression (15). \`sinter({ complexity: { …, level: 'warn' | 'error' | 'off' } })\` changes them.

## Magic names

${ALL_MAGIC.map((m) => `\`${m}\``).join(', ')}. \`$event\` in handlers, \`$result\` in \`then\`, \`$error\` (\`{status, body, message}\`) in \`catch\`; \`$meta.<resource>\` has \`loading\`, \`error\`, \`loadedAt\`, \`pending\`, \`total\`, and with \`paginate\`: \`page\` (offset), \`pages\`, \`from\`, \`to\`, \`hasPrev\`, \`hasNext\`.

## Store functions

${STORE_FNS.map((f) => `\`${f}()\``).join(', ')}: \`refresh('name')\` (or several: \`refresh('a', 'b')\`), \`upsert('name', item)\`, \`patch('name', item, {…})\`, \`remove('name', item)\`, \`page('name', 'next' | 'prev' | 'first' | 'last' | n)\` (a page number needs offset mode or keyset with \`offset-param\`, else SN304; a computed direction such as \`$event.shiftKey ? 'prev' : 'next'\` works everywhere, typed by \`sinter check\`; \`prev\` does nothing while \`hasPrev\` is false and \`next\` while \`hasNext\` is false, in every mode, so paging needs no \`$meta\` guard; \`first\` and \`last\` always load), \`showModal('id')\` opens a dialog by its literal id, \`close()\` the nearest dialog or \`close('id')\` that one, \`reset()\` the nearest form, \`emit('event', detail)\` (a bubbling, cancelable \`CustomEvent\`), \`run('id')\` starts the action of the element with that literal id (SN311), as its trigger would but with \`$event\` null; a form is submitted (\`requestSubmit()\`, validation runs); a disabled or inert element does nothing; it returns nothing, results go to the element's \`then\`/\`catch\`. The resource name may be chosen from literals: \`page(searching ? 'results' : 'messages', 'next')\`, \`||\`/\`??\` between literals, or a \`data-sn-let\` name whose value is one (\`data-sn-let="{ shown: searching ? 'results' : 'messages' }"\`, then \`page(shown, 'next')\`, \`$meta[shown].hasNext\`); every name it can take is checked like a literal; a state variable or helper result is SN301 (make it a \`?:\`).

## Write-through

A mutation's 2xx response is applied to the store by itself, before \`then\` runs (the \`apply\` module, loaded when a page has something to apply). With an OpenAPI spec: an object of a named schema in the response (\`{article: Article}\`) patches the same-key item in every list of that schema and what the URL named (\`{article.slug}\` names the single \`article\`; \`{article.author.username}\` also names \`article.author\`, a Profile); a POST to exactly a list's current URL inserts the created item (the response's, else body + returned key, else a refetch; a filtered or paginated list is never inserted into); a PUT/PATCH body patches the entity the URL named. Without a spec: a DELETE of a row's URL (the list's URL plus one segment, from \`c.id\` with \`c in comments\`) removes the row, and a PUT/PATCH body patches the row when its keys are fields of the row. Patches merge and skip unchanged fields; \`then\` writes land on top. So \`data-sn-then="patch('articles', a, $result.article)"\`, \`upsert('comments', $result.comment)\` and \`remove('comments', c)\` are not written (SN510 says so); \`data-sn-optimistic\` is still how a change shows before the answer. \`data-sn-apply="off"\` turns it off for one element.

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
- \`$result\` in \`<sn-resource then>\` has the resource's type (\`type\`, OpenAPI, or a \`call\`'s result).
- \`<sn-event … type="ContactEvent">\` types the payload; \`item\` must fit the resource's item, \`set\` part of it, and \`then\` is checked against it; \`cursor\` reads the item. No \`type\` on an event with payload expressions is warning SN506.
- In the URL, body, call arguments and confirm of an element \`run('id')\` starts (not a form), \`$event\` is \`RunEvent<…>\` (no event when run): guard reads with \`$event && $event.shiftKey\`.
- SN509 (\`run-cycle\`) is opt-in: \`sinter check --check-cycles\`, or \`sinter({ checkCycles: true })\` for the build, \`sinter check\` and \`sinter lsp\`. It reports \`then\`/\`catch\` handlers that start each other again through \`run()\` (and \`refresh()\`), with every step.
- Errors are SN208 at the HTML position, with TypeScript's message. Null checks are off. In tests: \`checkPage(html, { files, openapi })\` from \`@tiaforge-ui/sinter/check\`.
`);
  out.push(`## First paint

The built page shows its chrome before the page module has run; the page bundle is not render-blocking and is \`async\` (it does not wait for stylesheets), so it may run while the body is still being parsed: keep app code at module top level from reading the body, and don't read an island's children or later siblings in \`connectedCallback\`. The page module waits for the parse and for the early file before it mounts.

- Build-time constants are written into the HTML: bindings outside templates that read only literal \`data-sn-state\` fields and constants (\`aria-current\` from \`here === '/mail/'\`). No helpers.
- Each page gets an early chunk, bundled into one file with nothing to import and loaded \`type="module" blocking="render"\` before the page module (one request before the first paint): first \`src/sinter.early.ts\` (optional app code), then, once, the bindings outside \`data-sn-for\` templates that need no data: they read state fields whose initial value needs no data, persisted values (read from \`sn:<key>\` in localStorage), \`$locale\` and helpers. A \`data-sn-if\` of that kind renders its branch; the page module adopts it. Only the helpers and message members those bindings call are included. Modules it shares with the page bundle are copies: state the early module sets must be set again by the page bundle (sinter's messages share theirs through a global).
- Resources, \`$url\`, \`$now\`, \`$meta\`, \`$el\`, loops and the built-in formatters (\`date()\`, …) wait for the page module. The runtime then owns every binding; its first write changes nothing.
- Every origin a literal \`src\` names (resources and streams) gets \`<link rel="preconnect" crossorigin>\`. Data requests start before the page module: a resource with a literal same-origin \`src\` and no \`when\` gets \`<link rel="preload" as="fetch" crossorigin>\`; one whose URL reads only state that needs no data, persisted values, \`$now\`, \`$url\` and helpers is requested by the early file. The runtime takes those responses at the end of its middleware chain when the request is unchanged (no header or credentials added), so response middleware still runs; changed requests are sent again. Not for paginated, \`each\`, \`call\` or embedded resources. A resource only elements inside \`<dialog>\`s read is requested with low priority (\`fetchpriority="low"\` on its preload, \`priority: 'low'\` on its fetch).
- Next-page data: when the pointer rests on a same-origin link to another page of the app (65 ms), it has focus, or a press or touch starts on it, that page's resources whose \`src\`/\`when\` read only \`$url\`, constants and helpers are requested (low priority, through the middleware; data this page loaded from the same request is handed over without one). The next page shows them at once and revalidates; \`$meta.<name>.loadedAt\` stays null until the server answers. Entries are taken once, kept 30 s, dropped after any mutation; a failed prefetch never triggers \`onUnauthorized\`. Nothing to write: give pages \`data-sn-path\` patterns so links like \`/article/slug\` match. \`sinter({ prefetch: false })\` turns it off; test with \`render(html, { pages: { 'article.html': articleHtml } })\`. In Chromium, pages also get Speculation Rules for those links (\`sinter({ speculation: 'prefetch' | 'prerender' | false })\`, default \`'prefetch'\`); under a CSP add \`'inline-speculation-rules'\` to \`script-src\`. A prerendered page connects streams once shown and refetches then. A page that does something when it loads (logout) gets \`<html data-sn-prefetch=\"off\">\`: no page prefetches or prerenders it. Page transitions: with \`@view-transition { navigation: auto; }\` in the CSS (temper has it), \`data-sn-transition=\"'article-' + a.slug\"\` on an element of a list row and \`data-sn-transition=\"'article-' + $url.slug\"\` on the detail page morph one into the other when the row's link is followed (and back). Use one name per thing; the detail element must render with the page (not after a later load).
- Browsers without \`blocking="render"\` (Firefox, as of 159) would paint the body before the early file has rendered (a persisted collapsed rail shown open for a frame) and run CSS transitions from that state. There the page's first classic script (the language picker, else \`assets/sinter-paint-<hash>.js\`, on pages with an early file) sets \`visibility: hidden\` on \`<html>\` and turns transitions off (a constructed stylesheet: no inline style for the CSP) until the early file has rendered and the stylesheets have applied; after a layout flush both are back. The hiding lasts 2 s at most; without the early file, the window's \`load\` ends it. Chromium: nothing changes. Apps need no workaround for transitions on load.
- The build prints each page's early file size (gzip) and warns over \`sinter({ earlyBudget })\` (default 10000 bytes), naming the largest modules: keep heavy imports out of early code.
- Keep page chrome outside data templates: \`<template data-sn-if="user">\` around the navigation hides it until the user has loaded.
- \`sinter({ firstPaint: false })\` turns it off. Test with \`firstPaint(html, { helpers, storage, early })\` from the testing module (\`early\` stands for \`src/sinter.early.ts\`), and \`render(html, { firstPaint: { early, afterEarly } })\` for the takeover.
`);
  out.push(`## Messages

- With an inlang project (\`project.inlang/settings.json\`, message files \`messages/{locale}.json\` of plain \`"key": "text with {param}"\`), \`m.key()\` / \`m.key({ param })\` in markup are sinter's built-in messages. App code: \`import { m } from '@tiaforge-ui/sinter/messages'\`, typed by the generated \`src/sinter.messages.d.ts\`. Unknown keys are SN206, wrong or missing params SN208 (\`sinter check\`). Only \`m.key\`: \`m[key]\` or passing \`m\` on fails the build; a dynamic choice is a switch.
- The build emits one file per page and language with only the keys the page calls (markup and its modules); a missing translation is the base language, reported at build. No plurals or variants.
- Before the first paint a tiny classic script picks the language (localStorage \`locale\`, else \`navigator.languages\`, else the base), sets \`<html lang>\` and loads the page's language file render-blocking: on every page that calls \`m\`, in its markup or in a helper, action or island it bundles. \`$locale = 'de'\` switches without a reload (stores the choice, loads that file, re-renders). Don't \`configure({ locale })\`: sinter is the locale source.
- Tests: \`render(html, { messages: { en: {…}, de: {…} }, locale })\`. An app without an inlang project ships none of this.
`);
  out.push(`## Deploying streams

Each open EventSource holds one HTTP connection, and HTTP/1.1 allows 6 per origin: with more than 5 tabs open, pages stop loading. Serve streams over HTTP/2 (any TLS reverse proxy such as nginx or Caddy) or use the WebSocket transport; dev builds warn about HTTP/1.1.
`);
  out.push(`## Editors

\`npx sinter lsp --stdio\` is a language server for the project's HTML files: sinter's diagnostics as you type (partials checked through the pages that include them), and with TypeScript 7 type errors, hover, completion in expressions, go to definition and a did-you-mean quick fix; "Extract to helper" moves an expression into a typed function of the helpers module. VS Code: the extension in \`editors/vscode\`. Setup for Neovim, Helix and Emacs: \`docs/editors.md\`. Every diagnostic links to its explanation in \`docs/diagnostics.md\`.
`);
  out.push(`## Testing

Write a test next to the markup. \`@tiaforge-ui/sinter/testing\` compiles the page with the real compiler and mounts it:

- \`render(html, { requests, streams, url, locale, now, helpers, actions, files, storage, session, firstPaint })\` → \`{ root, app, flush, settle, advance, navigations, window }\`. Pass one \`memoryStorage()\` as \`session\` to two renders to test what carries over between page loads (the \`cache\` attribute). A full document keeps its \`<html>\` attributes, so state and \`data-sn-persist\` on \`<html>\` work as in the browser.
- \`mockRequests({ 'GET /api/x': json | {status, body} | (call) => … })\`: records \`calls\`; responses are held until \`settle()\`; an unmatched request fails the test and lists the routes.
- \`mockStream()\`: \`emit(name, payload)\`, \`drop()\`, \`connected\`. A stream URL with no mock uses the transport from \`configure({ transport })\`, so a custom transport can be tested over a fake connection (see the SignalR recipe).
- \`flush()\` runs the scheduler (optimistic changes are visible), \`settle()\` finishes requests, queues and debounces, \`advance(ms)\` moves sinter's clock.
- \`firstPaint(html, { helpers, files, storage, early })\` → \`{ root, html }\`: the page as the browser shows it before the page module runs (build-time constants, then the early chunk). \`render(…, { firstPaint: { early, afterEarly } })\` mounts over that first paint; \`afterEarly\` runs in between, so a test can watch what mounting changes.
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
      ...['escape', 'enter', 'arrowdown', 'arrowup', 'mod-enter'].map((k) => ({ name: `data-sn-on-keydown-${k}`, description: KEY_ON_DOC.doc })),
      ...['input', 'keyup', 'scroll'].map((e) => ({ name: `data-sn-debounce-${e}`, description: DEBOUNCE_ON_DOC.doc })),
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
