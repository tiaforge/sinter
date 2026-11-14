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

const REPO = 'https://github.com/tiaforge/sinter/blob/main';
// recipes shown in full in llms.txt; the others are listed by title and link, to keep it short (agents read all of it)
const INLINE = new Set(['list-filter', 'form-dialog', 'field-errors', 'sse-sync', 'optimistic-toggle', 'url-pagination', 'typed', 'local-actions']);

// [file, title, extra files shown with the markup]
const RECIPES: Array<[string, string, string[]?]> = [
  ['list-filter', 'List with filter'],
  ['form-dialog', 'Form dialog with repeatable fields'],
  ['field-errors', 'Server validation errors on the fields'],
  ['sse-sync', 'SSE sync'],
  ['optimistic-toggle', 'Optimistic toggle'],
  ['offline-draft', 'Offline drafts: sent again once the connection is back'],
  ['pagination', 'Pagination'],
  ['url-pagination', 'Pagination in the URL: page-model, shared links and Back'],
  ['url-search', 'Search in the URL: a model on $url, one history entry per search'],
  ['url-filter', 'A multi-select filter in the URL: an array parameter'],
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

Work in strict mode, so warnings fail like errors instead of scrolling past: \`sinter({ strict: true })\` in the Vite config (or \`SINTER_STRICT=1\`), \`npx sinter check --strict\` after every change, \`render(html, { strict: true })\` in tests (\`render()\` reads \`SINTER_STRICT\` too), and read the dev server's terminal, where strict mode prints the browser's runtime warnings. A clean exit means no warnings, not only no errors. Fix what a warning reports; do not turn strict mode off. Keep a code a warning only when the user agrees, in \`strict: { allow: { SN504: 'reason' } }\`. Details: docs/strict.md and "Type checking" below.

Paths under \`docs/\` are in the repository: https://github.com/tiaforge/sinter/tree/main/docs. \`docs/diagnostics.md\` also ships in this package.

## Attributes
`);
  for (const a of [...ATTRIBUTES, ON_DOC, KEY_ON_DOC, DEBOUNCE_ON_DOC]) out.push(`- \`data-sn-${a.name}\`${a.value ? ` (${a.value})` : ''}: ${a.doc}`);
  out.push(`
Key filters (\`data-sn-on-keydown-<modifiers->key\`, \`data-sn-on-keyup-…\`): modifiers ${Object.keys(MODIFIERS).map((m) => `\`${m}\``).join(', ')}, then one key: \`a\`–\`z\`, \`0\`–\`9\`, ${Object.keys(NAMED_KEYS).filter((k) => !/^f\d/.test(k)).map((k) => `\`${k}\``).join(', ')}, \`f1\`–\`f12\`, and characters by name: ${Object.entries(CHAR_KEYS).map(([n, c]) => `\`${n}\` (${c === '`' ? '``` ` ```' : `\`${c}\``})`).join(', ')}. Names are lowercase (N is \`shift-n\`). Filters on an ancestor skip keys typed into fields and Enter/Space on buttons and links; a match calls \`preventDefault()\`. The nearest element that handles an event wins; a key a plain handler does not \`preventDefault()\` goes on to its ancestors, so page-wide shortcuts go on \`<body>\`. Bubbling custom events (\`emit()\`, islands' events, \`sn-error\`, \`dismiss\`) run every handler from the target up until one calls \`$event.preventDefault()\`; \`stopPropagation()\` does not end the walk.`);
  out.push('\n## Elements\n');
  for (const e of ELEMENTS) out.push(`- \`<${e.name}>\` ${e.attrs.map((x) => `\`${x}\``).join(', ')}: ${e.doc}`);
  out.push(`
## Expressions and scope

- Attribute values are JavaScript expressions, checked at build time. Value expressions (text, attr, class, show, for, if, key, body, state, URL interpolations) cannot assign, use \`++\`, \`delete\`, \`await\` or \`import()\`.
- Handlers (\`data-sn-on-*\`, \`then\`, \`catch\`) are statements separated by \`;\`: assignments to state, \`$url.<param>\` and \`$locale\`, and calls. No declarations or loops.
- \`$url\` is bindable: \`data-sn-model="$url.q"\` (query parameters; path parameters are read-only), \`page-model="$url.page"\` on an offset list (the URL is then the list's single source: \`page()\` writes it, a filter change starts at page 1). History works as in a single-page app: user events add an entry, typing commits at each pause, other writes replace. Values are written as a reload reads them (strings; \`true\` as \`'1'\`; \`false\`/\`null\`/\`''\`/\`[]\` delete the parameter): use \`+$url.page\` for arithmetic. A parameter bound to a \`<select multiple>\` or checkboxes with a \`value\` is a list (\`[]\` when absent; SN211). Guide: docs/navigation.md#the-url-and-the-history.
- A handler cannot call an action function (SN203). To start an action from a handler (a key filter, \`data-sn-then\`, \`<sn-resource then>\`), give the action element an \`id\` and call \`run('id')\`; the element's busy state, concurrency, optimistic layer and \`then\`/\`catch\` apply. A hidden carrier works: \`<span hidden id="mark-read" data-sn-call="mail.markRead(open)"></span>\`. See the recipe "Run an action from a handler".
- \`then\` on \`<sn-event>\` is a handler run after the event's change is applied: payload fields are bare names, the state around the \`<sn-sync>\` is in scope and assignable, and so are its \`data-sn-let\` names (read-only; state and lets win over payload fields of the same name), store functions work (\`close('id')\` names its dialog: there is no element). With \`then\`, \`resource\` and \`op\` may be left out.
- \`then\` on \`<sn-resource>\` is a handler run after each successful load (first load, \`refresh()\`, refetch events, \`src\` changes, every \`page()\`; per source for \`each\`), not for cached data shown at once, failed loads or optimistic/event changes. \`$result\` is what the load stored (what \`items\` selects; the page just loaded). The state around the resource is in scope and assignable; \`close('id')\` names its dialog. It runs on every refetch, so a once-only handler guards itself, one step per guard: \`then="draft = $result ?? draft; $result && showModal('compose')"\`.
- Server errors on a form: a mutation without \`data-sn-catch\` on a form, or on a button or control inside one, that fails with a 4xx and a JSON body \`{errors: {<name>: message | message[]}}\` marks each control with that \`name\`: \`aria-invalid=\"true\"\` and the message in the element its \`aria-errormessage\` names, else in a \`<small data-sn-error data-tone=\"danger\">\` inserted after it; the first such field gets focus; editing a field clears its error, sending again clears all. Inside the form, \`$error\` is its last failed send (\`{status, body, message, detail}\`, or \`null\`; null again when sent again): show the rest with bindings, e.g. \`<template data-sn-if=\"$error\"><p data-sn-text=\"$error.detail\"></p></template>\`. Shown (no \`sn-error\`, no \`onError\`) when every message marked a field or the form reads \`$error\`. \`data-sn-catch\` opts out. Another response format: \`configure({ fieldErrors: (error, {url, method}) => ({ name: messages }) })\` reading \`error.body\` (\`null\`: mark no field; \`undefined\`: the default reading); codes instead of text: map them to \`m.key()\` there.
- \`refresh="30s"\` on \`<sn-resource>\` reloads it in the background once its last load is that old (not while the tab is hidden or \`when\` is falsy; \`$meta.loading\` stays false). A reload with an unchanged \`ETag\` (else \`Last-Modified\`) is not re-rendered, \`then\` still runs; servers send \`ETag\` with \`Cache-Control: no-cache\`.
- \`data-sn-optimistic\` may only call \`patch\`, \`upsert\`, \`remove\`. The change shows at once, stays when the request succeeds (committed under what \`then\` writes) and is rolled back when it fails. With an inline edit, leave edit mode when the form is sent, not in \`then\` (which waits for the server): \`<form data-sn-patch="/api/items/{i.id}" data-sn-optimistic="patch(i, { title })" data-sn-on-submit="editingId = null" data-sn-catch="…">\`. The request, the rollback and \`catch\` still run after the form is gone.
- A name resolves innermost first: loop variables, then the nearest \`data-sn-state\`, then resources, then magic names, helpers and store functions, then JavaScript globals. Browser APIs (\`window\`, \`document\`, \`fetch\`, timers, …) are refused: use a component's script.
- Resources are read-only: copy an item with \`structuredClone(c)\` to edit it, write with \`patch()\`.
- Helpers are plain function calls, never pipes: ${BUILTIN_HELPERS.map((h) => `\`${h}()\``).join(', ')}. Helper namespaces: \`m.inbox_title()\`.
- URL templates: \`/api/x?id={c.id}\`; interpolations are URL-encoded; the template must start with a literal \`/path\` or \`https://origin\`. A whole query value that is \`null\`/\`undefined\` or an empty array leaves the parameter out; an array is a repeated key (\`?cal={cals}\` → \`cal=a&cal=b\`); an array in the path is refused.
- Use \`$now\` instead of \`Date.now()\` so bindings update.

## Components

- A component is a file \`src/components/<name>.html\` (the name has a \`-\`), used as \`<name>\` on any page. It holds one \`<template data-sn-component="{ article: Article; compact?: boolean }">\` with exactly one root element, and optionally a \`<style>\`. \`data-sn-emits="{ select: Article }"\` on the template declares its events.
- Every use is expanded at build time: the root element replaces the tag, so the component renders in the first frame like page markup and needs no runtime. The caller's \`class\` is joined with the root's; other attributes, handlers (\`data-sn-on-<event>\`), actions, \`data-sn-class\`, \`-attr\`, \`-style\`, \`-show\` move onto the root in the caller's scope.
- Props go in with \`data-sn-prop="{ article: a, compact: narrow }"\`: each is the caller's expression, live and read-only. An optional prop not passed is \`undefined\`, or the root's \`data-sn-state\` field of the same name. The component sees only its props, its own state, resources, helpers and magic names; slot content (\`<slot>\`, \`<slot name="meta">\` with fallback content, filled by the caller's children and \`slot="meta"\`) sees the caller's scope.
- Events come out with \`emit('select', article)\` (names checked against \`data-sn-emits\`); the caller handles them with \`data-sn-on-select\`, \`$event.detail\` typed. \`data-sn-model="draft.stars"\` binds a component that declares a \`value\` prop and a \`change\` event.
- A component with a script: \`src/components/<name>.ts\` beside its HTML, \`export class TaskRing extends TaskRingComponent\` (imported from \`./task-ring.html\`, typed by the generated \`src/sinter.components.d.ts\`). sinter creates it per instance and calls \`connected()\` (markup rendered, refs set), \`propsChanged()\` and \`disconnected()\`; it reads \`this.props\`, writes \`this.state\` (renders), uses \`this.refs.<name>\` (\`data-sn-ref\` in its markup), \`this.root\` and \`this.emit()\`. It writes only state, never nodes sinter renders. Use it for browser work (canvas, libraries, timers) instead of a custom element.
- A component may use itself (a tree: comments and replies) when the inner use is inside a \`data-sn-for\` or \`data-sn-if\` template (else SN306): \`<template data-sn-for="r in comment.replies" data-sn-key="r.id"><comment-thread data-sn-prop="{ comment: r }"></comment-thread></template>\`. \`patch(r, …)\` and \`remove(r)\` change a nested item along its path at any depth; \`upsert(comment.replies, x)\` adds to a nested list. Nested loops need \`data-sn-key\`.
- \`<sn-component use="\`\${b.type}-block\`" data-sn-prop="{ block: b }">\` picks a component per item: a template string, a map in the markup (\`use="{ hero: 'hero-block' }[b.type]"\`) or a helper; it must fit \`ComponentName\` (\`b.type + '-block'\` is a \`string\`: write the template string); a \`data-sn-else\` template after it renders for a value outside the candidates.
- \`data-sn-early="off"\` on a component's tag (\`<tag-cloud data-sn-early="off">\`) leaves that use out of the early script (smaller head script; it renders when the page module runs, so it may shift the layout then).
- \`<sn-include>\` is removed (SN316): a partial is a component.
- A head component is a file \`src/components/<name>.html\` with \`<template data-sn-head="{ title?: string }">\` instead of \`data-sn-component\`: it holds any number of head elements (\`<title>\`, \`<meta>\`, \`<link>\`, \`<script>\`, \`<style>\`, \`<noscript>\`, \`<base>\`, \`<template data-sn-if>\`, slots, other head components), inlined at its use in a \`<head>\` with no wrapper. Its tag takes only \`data-sn-prop\` and slot content. A head component in a body, a component in a head, a body element in a head component: SN320.
- In a head, \`<title data-sn-text>\` binds, and a \`<meta>\` with a literal \`name\`, \`property\` or \`itemprop\` binds its \`content\`: \`<meta name="description" content="Fallback" data-sn-attr="{ content: post?.summary ?? 'Fallback' }">\`. Nothing else in a head binds (SN207). Constants are written into the HTML at build time; values from data render when it arrives, so scrapers that run no script see the literal content. A second \`<title>\`, \`<meta name="description">\`, \`og:title\`… in one head is SN321.
- A slot that is slot content of a component's tag forwards what fills it: \`<seo-tags><slot name="seo" slot="extra"></slot></seo-tags>\` puts the caller's \`slot="seo"\` content into \`seo-tags\`'s \`extra\` slot, in the caller's scope.

## Layouts

- A layout is a whole document \`src/layouts/<name>.html\` (the name has a \`-\`) whose \`<html>\` declares its props: \`<!doctype html><html lang="en" data-sn-layout="{ title?: string; nav: string }"><head>…<slot name="head"></slot></head><body>…<slot></slot></body></html>\`. It has any number of named slots in its head and body; the default slot is in the body (a default slot in the head: SN318). No script beside it, no \`data-sn-emits\`.
- A page that uses it is only its tag: \`<site-layout data-sn-path="/post/:slug" data-sn-state="{ tab: 'all' }" data-sn-prop="{ nav: 'post', title: post?.title }">…</site-layout>\` (anything else on the page, or the tag anywhere else: SN319). Children fill the slots; a head element goes to a head slot with \`slot="head"\` (a \`<title>\`/\`<meta>\`/\`<link>\` for a body slot: SN320). Plain attributes on the tag replace the layout's on \`<html>\` (\`lang\`, \`dir\`; \`class\` is joined); \`data-sn-path\` and \`data-sn-prefetch\` go onto \`<html>\`. Handlers on the tag are the page's \`<body>\` handlers (on the layout's \`<body>\`, ahead of its own): DOM events, \`sn-error\` and \`dismiss\` only (SN315), e.g. \`data-sn-on-sn-error\` and \`data-sn-on-keydown-shift-n\`.
- \`data-sn-state\` on the tag is the page's state: the props and all slot content see it, the layout's markup does not. The layout's markup sees its props, its own state, the page's resources and the globals.
- The merge happens before anything reads the page: early scripts, preloads, embedded data, Google Fonts and Vite's bundling of the layout's \`<script type="module">\` and stylesheets work on the merged document. Relative URLs in the layout (\`./site.css\`) are relative to the layout file. Layouts are not pages: leave \`src/layouts/\` out of the build's inputs (SN318).

## What belongs in markup

- Markup holds filters, conditions, single assignments and short calls. Logic goes into a helper when it computes a value (pure: unit-test it without a page), or into an action when it has side effects (\`data-sn-call\`).
- Handlers apply a helper's result to state: \`data-sn-on-click="sel = rowClick($event, sel, f.id, ids)"\`, not branches on \`$event.shiftKey\` in the attribute. See the row selection recipe.
- One step per condition: \`open && close('detail')\` is fine; \`a && (b = null, close())\` is not: split it into statements, let the dialog's \`data-sn-on-close\` reset state, or compute the new state in a helper.
- Warning SN507 (\`complex-expression\`) flags expressions that outgrew markup and names the limit: statements per handler (4), comma sequences (0), steps behind one \`&&\`/\`||\`/\`?:\` statement (1), \`?:\` nesting (2), operations in an arrow function (8), operations per expression (15). \`sinter({ complexity: { …, level: 'warn' | 'error' | 'off' } })\` changes them.

## Magic names

${ALL_MAGIC.map((m) => `\`${m}\``).join(', ')}. \`$event\` in handlers, \`$result\` in \`then\`, \`$error\` (\`{status, body, message}\`) in \`catch\`; \`$meta.<resource>\` has \`loading\`, \`error\`, \`loadedAt\`, \`pending\`, \`total\`, \`live\` (\`'connecting'\`, \`'open'\` or \`'retrying'\` for a resource a \`<sn-sync>\` event feeds, the worst of its streams; \`null\` otherwise), and with \`paginate\`: \`page\` (offset), \`pages\`, \`from\`, \`to\`, \`hasPrev\`, \`hasNext\`.

## Store functions

${STORE_FNS.map((f) => `\`${f}()\``).join(', ')}: \`refresh('name')\` (or several: \`refresh('a', 'b')\`), \`upsert('name', item)\`, \`patch(item, {…})\`, \`remove(item)\` (no resource name: they act on the item in the resource it came from, found by key: a row of a \`data-sn-for\` over a resource, also through \`filter\`/\`toSorted\` or a helper given one resource; an element (\`list[0]\`, \`.find(…)\`); a single resource; a prop or emitted detail that is one; state assigned one, \`sel = m\` or \`structuredClone(m)\`; anything else is SN317), \`page('name', 'next' | 'prev' | 'first' | 'last' | n)\` (a page number needs offset mode or keyset with \`offset-param\`, else SN304; a computed direction such as \`$event.shiftKey ? 'prev' : 'next'\` works everywhere, typed by \`sinter check\`; \`prev\` does nothing while \`hasPrev\` is false and \`next\` while \`hasNext\` is false, in every mode, so paging needs no \`$meta\` guard; \`first\` and \`last\` always load), \`showModal('id')\` opens a dialog by its literal id, \`close()\` the nearest dialog or \`close('id')\` that one, \`reset()\` the nearest form, \`emit('event', detail)\` (a bubbling, cancelable \`CustomEvent\`), \`navigate(url)\` (to this page with only parameters it reads changed: in the page, as a same-page link; else the browser loads it; \`{ replace: true }\`: in the current history entry), \`run('id')\` starts the action of the element with that literal id (SN311), as its trigger would but with \`$event\` null; a form is submitted (\`requestSubmit()\`, validation runs); a disabled or inert element does nothing; it returns nothing, results go to the element's \`then\`/\`catch\`. The resource name may be chosen from literals: \`page(searching ? 'results' : 'messages', 'next')\`, \`||\`/\`??\` between literals, or a \`data-sn-let\` name whose value is one (\`data-sn-let="{ shown: searching ? 'results' : 'messages' }"\`, then \`page(shown, 'next')\`, \`$meta[shown].hasNext\`); every name it can take is checked like a literal; a state variable or helper result is SN301 (make it a \`?:\`).

## Write-through

A mutation's 2xx response is applied to the store by itself, before \`then\` runs (the \`apply\` module, loaded when a page has something to apply). With an OpenAPI spec: an object of a named schema in the response (\`{article: Article}\`) patches the same-key item in every list of that schema and what the URL named (\`{article.slug}\` names the single \`article\`; \`{article.author.username}\` also names \`article.author\`, a Profile); a POST to exactly a list's current URL inserts the created item (the response's, else body + returned key, else a refetch; a filtered or paginated list is never inserted into); a PUT/PATCH body patches the entity the URL named. Without a spec: a DELETE of a row's URL (the list's URL plus one segment, from \`c.id\` with \`c in comments\`) removes the row, and a PUT/PATCH body patches the row when its keys are fields of the row. Patches merge and skip unchanged fields; \`then\` writes land on top. So \`data-sn-then="patch(a, $result.article)"\`, \`upsert('comments', $result.comment)\` and \`remove(c)\` are not written (SN510 says so); \`data-sn-optimistic\` is still how a change shows before the answer. \`data-sn-apply="off"\` turns it off for one element.

## Retries

Nothing is sent again unless a retry policy says so. Policies are named in the config module: \`import { retry } from '@tiaforge-ui/sinter/retry'; configure({ sessionProbe: '/api/user', retry: retry({ policies: { drafts: { backoff: ['1s', '30s'] }, network: { backoff: ['1s', '10s'], retries: 3 } }, get: 'network' }) })\` (fields: \`backoff: [first, longest]\`, \`retries\`, \`maxAge\`, \`key\`: the header, default \`Idempotency-Key\`, or \`false\`). A write opts in on its element: \`data-sn-retry="drafts"\` (mutations only; writes have no default). \`get\` is the policy of every GET except background refreshes. A network error waits, then the session probe decides (2xx: send again, 401: lost to the login redirect); a 5xx is a failed try; a 429 or 503 waits for \`Retry-After\` and fails at once when that is after the policy's last try; a retried DELETE that gets 404 succeeded; other 4xx fail at once. Each trigger sends one idempotency key on every try. A server that ignores the key may create a duplicate from a retried POST: create with a client id (\`PUT /api/notes/{uuid}\`). While a write waits, its element keeps \`aria-busy\` (show "not saved" with \`body:has(form[aria-busy])\`), its optimistic change stays, \`latest\` replaces it with a newer trigger (use it for drafts: \`block\` keeps a form disabled), and leaving the page asks first (not on iOS).

## Diagnostics

${Object.entries(CODES).map(([c, n]) => `\`${c} ${n}\``).join(', ')}.

## Recipes

Each recipe has a test beside it (\`docs/recipes/<name>.test.ts\`).
`);
  for (const [file, title, extra = []] of RECIPES.filter((r) => INLINE.has(r[0]))) {
    out.push(`### ${title}\n`);
    out.push('```html\n' + readFileSync(`${recipes}/${file}.html`, 'utf8').trim() + '\n```\n');
    for (const x of extra) out.push('```' + (x.endsWith('.ts') ? 'ts' : 'js') + '\n' + readFileSync(`${recipes}/${x}`, 'utf8').trim() + '\n```\n');
  }
  out.push('### More recipes\n');
  for (const [file, title, extra = []] of RECIPES.filter((r) => !INLINE.has(r[0]))) {
    out.push(`- ${title}: ${[`${file}.html`, ...extra].map((f) => `${REPO}/docs/recipes/${f}`).join(', ')}`);
  }
  out.push('');
  out.push(`## Type checking

\`npx sinter check\` type-checks every expression with the project's TypeScript (pages and options come from the Vite config). \`sinter({ typecheck: true })\` runs it in \`vite build\`.

- \`<sn-resource … type="Contact[]">\`: the type of what \`items\` selects, using names exported by \`src/sinter.types.ts\`. \`type="any"\` opts out; no \`type\` is warning SN504.
- APIs: \`sinter({ apis: { main: { base, openapi: 'openapi.yml', credentials, headers, defaults: { 'GET /articles': { items, total, key, type, query } }, operations: { … } } }, defaultApi })\`. Pages write paths relative to an API: \`src="/articles?tag={t}"\`, \`src="billing:/invoices"\`, \`data-sn-delete="/articles/{a.slug}"\`, \`src="site:/config.json"\` (the page's own origin). Every path must be an operation the API declares (spec or \`operations\`) with the place's method (SN326), with declared and required query parameters, \`paginate\`'s included (SN327); an absolute URL is SN328. \`items\`/\`total\`/\`key\`/\`type\` come from \`defaults\`/\`operations\`: restating them is SN518 (same) or SN330 (different). \`key\` is never guessed: a list of objects without it is SN517. Each request carries its API's credentials and headers; \`apiOf(url)\` names the API in a middleware. \`<sn-resource method="POST" body="{ q }">\` loads with a POST (no cache, paginate, each). \`npx sinter migrate --write\` rewrites URLs into paths. Resources are typed from the operation's JSON response at \`items\`; every build checks \`items\`/\`total\` against the schema (SN308). Guide: docs/apis.md. The older \`sinter({ openapi })\` (deprecated) matches full \`src\` URLs and only warns (SN505).
- State takes a JSDoc cast where the literal is not enough: \`data-sn-state="{ editing: /** @type {Contact|null} */ (null) }"\`.
- Actions matched in the spec: \`data-sn-body\` is checked against the request schema, \`$result\` in \`then\` has the response type.
- \`$result\` in \`<sn-resource then>\` has the resource's type (\`type\`, OpenAPI, or a \`call\`'s result).
- \`<sn-event … type="ContactEvent">\` types the payload, the object the server sends: \`item="contact"\` on a resource of \`Contact[]\` is \`type="{ contact: Contact }"\`; \`item\` must fit the resource's item, \`set\` part of it, and \`then\` is checked against it; \`cursor\` reads the item. No \`type\` on an event with payload expressions is warning SN506.
- In the URL, body, call arguments and confirm of an element \`run('id')\` starts (not a form), \`$event\` is \`RunEvent<…>\` (no event when run): guard reads with \`$event && $event.shiftKey\`.
- Strict mode (\`sinter({ strict: true })\`, or \`SINTER_STRICT=1\`): warnings fail \`sinter check\`, \`vite build\`, pages in the dev server and \`render()\` in tests; runtime warnings are printed in the dev server's terminal and overlay. Run \`sinter check --strict\` after a change and fix what it reports rather than treating warnings as noise. \`sinter({ strict: { allow: { SN504: 'reason' } } })\` keeps a code a warning, with the reason. SN525–SN528 (machine or network), SN507 and runtime warnings that depend on the environment stay warnings. A test about a warning: \`render(html, { strict: false })\` and \`warnings()\`. docs/strict.md.
- SN509 (\`run-cycle\`) is opt-in: \`sinter check --check-cycles\`, or \`sinter({ checkCycles: true })\` for the build, \`sinter check\` and \`sinter lsp\`. It reports \`then\`/\`catch\` handlers that start each other again through \`run()\` (and \`refresh()\`), with every step.
- Errors are SN208 at the HTML position, with TypeScript's message. Null checks are off. In tests: \`checkPage(html, { files, openapi })\` from \`@tiaforge-ui/sinter/check\`; \`render(html, { apis })\` takes the APIs with parsed specs.
`);
  out.push(`## First paint

The built page shows its chrome before the page module runs. The page bundle is \`async\` and may run while the body is still being parsed: app code at module top level must not read the body, and an island's \`connectedCallback\` must not read its children or later siblings. Guide: docs/first-paint.md.

- Build-time constants are written into the HTML: bindings outside templates that read only literal \`data-sn-state\` fields nothing writes, and \`data-sn-for\` over a constant list.
- An early script renders, before the first paint, the bindings outside \`data-sn-for\` templates that need no data (initial state, persisted values, \`$locale\`, helpers). Optional app code for it goes in \`src/sinter.early.ts\`; state it sets must be set again by the page bundle. Resources, \`$url\`, \`$now\`, \`$meta\`, loops and the formatters (\`date()\`, …) wait for the page module, except a resource's loading state: \`<template data-sn-if="$meta.people.loading && !people.length">\` renders early. Keep heavy imports out of early code (\`sinter({ earlyBudget })\`, default 10000 bytes gzip).
- Keep page chrome outside data templates: \`<template data-sn-if="user">\` around the navigation hides it until the user has loaded.
- A page with nothing left to run (no state anything writes, no data, \`$url\`, helpers, handlers, actions, models or component scripts) ships no JavaScript. \`sinter({ static: ['about.html', 'docs/**'] | true })\` makes that a rule: a listed page that needs the runtime is SN322. Guide: docs/static-pages.md.
- Page URLs: a page without \`data-sn-path\` is a directory's index (\`about.html\` is \`/about/\`; not \`index.html\`, \`404.html\`, \`200.html\`). Links in the markup to a page, by file or URL, are rewritten to its URL; links built at run time are not: write \`'/task/?id=' + t.id\`, not \`'/task.html?id='\`. A page with \`data-sn-path\` answers at exactly its absolute paths or patterns (\`/article/:slug\`, \`/ /tag/:tag\`, \`/login\`); its own directory URL is SN515. The build writes \`_redirects\` (\`sinter({ redirects: false })\`); \`vite dev\`, \`vite preview\` and sinter-axum follow the same rules.
- Canonical URLs: \`sinter({ site: 'https://example.com' })\`; \`$site\` is the origin with \`base\`, \`$canonical\` the page's URL (\`<meta property="og:url" data-sn-attr="{ content: $canonical }">\`); pages get \`<link rel="canonical">\`. Either name without \`site\` is SN323.
- Languages in the URL: \`sinter({ localePrefix: true })\` with the built-in messages (\`baseLocale\` among \`locales\`) builds each page once per language (\`/en/about/\`, \`/de/about/\`). \`localeUrl('de')\` is this page in German (\`<a hreflang="de" data-sn-attr="{ href: localeUrl('de') }">\`); assigning \`$locale\` there is SN203. \`data-sn-path\` is written without the prefix; \`$url\` excludes it.
- Reserved space: a \`data-sn-for\` outside templates over a paginated resource holds its \`page-size\` rows' space, sized from the stylesheets, until the data arrives; the build prints each paginated list without space and why. A list over late data in a box whose width follows its content keeps what follows hidden while its first rows load (3 s at most; \`data-sn-wait="off"\` on the box). SN529: give the box a width (\`flex: 1 1 0\`) or the rows one. SN530: an image without a height in such rows.
- Data requests start before the page module (preload or the early script) for resources whose \`src\` is same-origin or in \`sinter({ origins: ['https://api.example.com'] })\`; list API origins there, not in \`configure({ origins })\`. \`<sn-resource early="off">\` for a resource whose request a middleware changes (an \`Authorization\` header).
- Next-page data: a link to another page of the app that the pointer rests on, focuses or presses loads that page's resources ahead (whose \`src\`/\`when\` read only \`$url\`, constants and helpers); give pages \`data-sn-path\` patterns so links match. \`sinter({ prefetch: false })\` turns it off; \`<html data-sn-prefetch="off">\` on a page that does something when it loads (logout). Chromium also gets Speculation Rules (\`sinter({ speculation })\`), an inline script: a CSP sent as a header needs \`'inline-speculation-rules'\`. Page transitions: \`@view-transition { navigation: auto; }\` and the same \`data-sn-transition="'article-' + a.slug"\` name on a list row and on the detail page (\`'article-' + $url.slug\`). Guide: docs/navigation.md.
- Same-page links: a plain click on a link to this page that changes only query parameters it reads stays on the page (a history entry; \`$url\` takes the link's query). Build the whole query: \`href="?page=3"\` drops the other parameters (SN519).
- Embedded data: \`<script type="application/json" data-sn-data="name">\` in the head (filled by a server or middleware) renders in the first frame, rows included. \`sinter({ embed: true })\` with \`import { embed } from '@tiaforge-ui/sinter/server'\` does this for Hono, Bun, Deno and Workers: \`export default { fetch: (await embed<Build>({ dir: 'dist', data: { … } })).wrap(app.fetch) }\`. Guide: docs/server.md.
- Google Fonts links are downloaded and bundled at build time (\`sinter({ fonts: { inline: false } })\` turns it off).
- Heavy packages: \`sinter({ lazy: ['openpgp'] })\` loads a package on first call. Import it as usual; every call of its exports must be waited for (\`await\`, \`return\`, \`.then\`, \`void\`); \`new\`, \`instanceof\`, constants, functions passed as values, side-effect imports and re-exports are SN324, and so is a helpers module that reaches it. A component script may use it freely (it loads with the component). \`data-sn-import="openpgp"\` loads it when an element renders, \`data-sn-preload="openpgp"\` adds modulepreload links. SN325: the package reached through another one, or a module both imported and lazily loaded. A chunk a deploy removed gives \`$error.stale = true\`. Guide: docs/lazy.md.
- \`sinter({ firstPaint: false })\` turns it off. Test with \`firstPaint(html, { helpers, storage, early })\` from the testing module (\`early\` stands for \`src/sinter.early.ts\`), and \`render(html, { firstPaint: { early, afterEarly } })\` for the takeover.
`);
  out.push(`## Images

Write plain \`<img src="./photo.jpg" alt="…">\` (a local JPEG, PNG, WebP or AVIF, relative to the page or component): the build makes a \`<picture>\` with AVIF or WebP files for every screen, \`width\`/\`height\`, lazy loading after the first image and a placeholder color, sized from the stylesheets (write \`sizes\` yourself only where the CSS cannot be followed: \`em\`, \`vh\`, unequal grid tracks, \`:hover\`). Needs sharp; \`sinter({ images: false })\` turns it off. Guide: docs/images.md.

- \`width\`/\`height\` smaller than the source: a fixed box with 1x/2x files; a source with too few pixels for 2x is SN511. A fixed width from the stylesheets (Tailwind's \`size-12\` too) is a box as well.
- To crop: \`width\` and \`height\` of the box plus \`style="object-fit: cover"\` (and \`object-position\`). Another ratio without \`object-fit\` is SN512 (stretched).
- Images from the API: \`sinter({ images: { remote: { url: 'https://img.example.com/{w}/{url}', origins: ['self'] } } })\` (or a preset: \`cloudflare\`, \`vercel\`, \`netlify\`, \`imgproxy:<base>\`) gives \`<img data-sn-attr="{src: c.avatar}">\` a \`srcset\`. Tests: \`render(html, { remoteImages, css })\`.
- CSS backgrounds (\`background: url(./hero.jpg) center / cover\`) get \`image-set()\`; use a source twice the largest width shown.
- Left as written: remote URLs, SVG, GIF, an \`<img>\` with \`srcset\`, inside your own \`<picture>\`, or with \`data-sn-*\` bindings.
`);
  out.push(`## Messages

- With an inlang project (\`project.inlang/settings.json\`, message files \`messages/{locale}.json\` of plain \`"key": "text with {param}"\`), \`m.key()\` / \`m.key({ param })\` in markup are sinter's built-in messages. App code: \`import { m } from '@tiaforge-ui/sinter/messages'\`, typed by the generated \`src/sinter.messages.d.ts\`. Unknown keys are SN206, wrong or missing params SN208 (\`sinter check\`). Only \`m.key\`: \`m[key]\` or passing \`m\` on fails the build; a dynamic choice is a switch.
- The build emits one file per page and language with only the keys the page calls (markup and its modules); a missing translation is the base language, reported at build. No plurals or variants.
- Before the first paint the head script picks the language (localStorage \`locale\`, else \`navigator.languages\`, else the base), sets \`<html lang>\` and starts the page's language file without waiting for it; the base language's text is in the HTML, hidden for other languages until rendered (3 s at most): on every page that calls \`m\`, in its markup or in a helper, action or island it bundles. \`$locale = 'de'\` switches without a reload (stores the choice, loads that file, re-renders). Don't \`configure({ locale })\`: sinter is the locale source.
- Tests: \`render(html, { messages: { en: {…}, de: {…} }, locale })\`. An app without an inlang project ships none of this.
`);
  out.push(`## Deploying streams

Each open EventSource holds one HTTP connection, and HTTP/1.1 allows 6 per origin: with more than 5 tabs open, pages stop loading. Serve streams over HTTP/2 (any TLS reverse proxy such as nginx or Caddy) or use the WebSocket transport; dev builds warn about HTTP/1.1.
`);
  out.push(`## Editors

\`npx sinter lsp --stdio\` is a language server for the project's HTML files: sinter's diagnostics as you type (components checked through the pages that use them), and with TypeScript 7 type errors, hover, completion in expressions, go to definition and a did-you-mean quick fix; "Extract to helper" moves an expression into a typed function of the helpers module. VS Code: the extension in \`editors/vscode\`. Setup for Neovim, Helix and Emacs: \`docs/editors.md\`. Every diagnostic links to its explanation in \`docs/diagnostics.md\`.
`);
  out.push(`## Testing

Write a test next to the markup. \`@tiaforge-ui/sinter/testing\` compiles the page with the real compiler and mounts it:

- \`render(html, { requests, streams, url, locale, now, helpers, actions, files, components, layouts, scripts, storage, session, firstPaint })\` → \`{ root, app, state, flush, settle, advance, navigations, window }\`. The page is compiled as a build compiles it (build-time constants, decided branches, unrolled loops). \`state(el).update(fn)\` writes the scope around \`el\` and re-renders it; it throws for a field nothing on the page writes, which the build made a constant (write it from a handler instead). Pass one \`memoryStorage()\` as \`session\` to two renders to test what carries over between page loads (the \`cache\` attribute). A full document keeps its \`<html>\` attributes, so state and \`data-sn-persist\` on \`<html>\` work as in the browser.
- \`mockRequests({ 'GET /api/x': json | {status, body} | (call) => … })\`: records \`calls\`; responses are held until \`settle()\`; an unmatched request fails the test and lists the routes.
- \`mockStream()\`: \`emit(name, payload)\`, \`drop()\`, \`connected\`. A stream URL with no mock uses the transport from \`configure({ transport })\`, so a custom transport can be tested over a fake connection (see the SignalR recipe).
- \`flush()\` runs the scheduler (optimistic changes are visible), \`settle()\` finishes requests, queues and debounces, \`advance(ms)\` moves sinter's clock.
- \`firstPaint(html, { helpers, files, storage, early })\` → \`{ root, html }\`: the page as the browser shows it before the page module runs (build-time constants, then the early chunk). \`render(…, { firstPaint: { early, afterEarly } })\` mounts over that first paint; \`afterEarly\` runs in between, so a test can watch what mounting changes.
`);
  return out.join('\n');
}

function diagnostics(): string {
  const out = [`# sinter diagnostics

Generated from \`src/compiler/diagnostic-docs.ts\` by \`npm run docs\`. Every diagnostic links to its section here. Codes from SN500 up are warnings; the rest are errors and fail the build. \`sinter check --strict\` fails on warnings too, except the ones that depend on the machine or the network (SN525 to SN528) and SN507 ([docs/strict.md](strict.md)). Codes from SN520 up are reported by the build rather than by a page, without a file and line.
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


// Attribute reference for people: the vocabulary grouped by what it does. A new attribute must be placed in a group.
const ATTRIBUTE_GROUPS: Array<[string, string, string[]]> = [
  ['Show data', 'Bind values to the page.', ['text', 'attr', 'class', 'style', 'show', 'prop', 'for', 'key', 'if', 'else']],
  ['Keep state', 'Local state next to the markup that uses it.', ['state', 'let', 'model', 'persist']],
  ['Send changes', 'Turn an element into a request. Details: [actions](actions.md).', ['get', 'post', 'put', 'patch', 'delete', 'call', 'body', 'trigger', 'debounce', 'encoding', 'concurrency', 'confirm', 'retry', 'apply']],
  ['After a request', 'What happens on screen around a response. Details: [optimistic updates](actions.md#optimistic-updates).', ['optimistic', 'then', 'catch']],
  ['React to events', 'Handlers without a request. Details: [events](actions.md), [key filters](actions.md).', ['on-<event>', 'debounce-<event>', 'listbox']],
  ['Components', 'In a component file in `src/components/`, and on a component\'s tag (`early`). Details: [components](components.md).', ['component', 'head', 'emits', 'early', 'ref', 'layout']],
  ['Pages and navigation', 'Set on `<html>` or on shared elements; `wait` on a box around a list. Details: [navigation](navigation.md), [first paint](first-paint.md).', ['path', 'prefetch', 'transition', 'data', 'wait']],
  ['Lazy packages', 'When a package of `sinter({ lazy })` loads, on any element of a page, a layout or a component. Without either, on first call. Details: [lazy packages](lazy.md).', ['import', 'preload']],
];
const RESOURCE_GROUPS: Array<[string, string[]]> = [
  ['Where the data comes from', ['name', 'src', 'method', 'body', 'call', 'each', 'when', 'early']],
  ['What it looks like', ['key', 'items', 'total', 'order', 'type']],
  ['How fresh it is', ['cache', 'refresh', 'then']],
  ['Pagination', ['paginate', 'page-size', 'size-param', 'cursor', 'direction-param', 'direction-values', 'page-param', 'offset-param', 'page-model']],
];

// Markdown-safe text for a table cell or sentence: `|` would split the row, and a bare <tag> outside code is
// swallowed as HTML.
function md(text: string): string {
  return text.split(/(`[^`]*`)/).map((part, i) => i % 2 ? part.replace(/\|/g, '\\|') : part.replace(/\|/g, '\\|').replace(/</g, '&lt;').replace(/>/g, '&gt;')).join('');
}

function attributes(): string {
  const all = [...ATTRIBUTES, ON_DOC, KEY_ON_DOC, DEBOUNCE_ON_DOC];
  const placed = new Set<string>(ATTRIBUTE_GROUPS.flatMap((g) => g[2]));
  const out = [`# Attribute reference

Every directive is a \`data-sn-*\` attribute or an \`<sn-*>\` element; anything else is a build error with a suggestion. Generated from the compiler's vocabulary (\`npm run docs\`). \`llms.txt\` has the same list for LLMs.
`];
  for (const [title, intro, names] of ATTRIBUTE_GROUPS) {
    out.push(`## ${title}\n\n${intro}\n\n| Attribute | Value | Meaning |\n| --- | --- | --- |`);
    for (const n of names) {
      const a = all.find((x) => x.name === n);
      if (!a) throw new Error(`unknown attribute ${n} in ATTRIBUTE_GROUPS`);
      out.push(`| \`data-sn-${a.name}\` | ${md(a.value ?? '')} | ${md(a.doc)} |`);
    }
    out.push('');
  }
  const missing = ATTRIBUTES.filter((a) => !placed.has(a.name)).map((a) => a.name);
  if (missing.length) throw new Error(`attributes without a group: ${missing.join(', ')}`);
  out.push('## Elements\n');
  for (const e of ELEMENTS) {
    if (e.name === 'sn-resource') {
      const placedR = new Set(RESOURCE_GROUPS.flatMap((g) => g[1]));
      const missingR = e.attrs.filter((x) => !placedR.has(x));
      if (missingR.length) throw new Error(`sn-resource attributes without a group: ${missingR.join(', ')}`);
      out.push(`### \`<sn-resource>\`\n\nA named, page-wide cache of server data. Details: [resources](resources.md).\n`);
      for (const [g, names] of RESOURCE_GROUPS) out.push(`- **${g}:** ${names.map((x) => `\`${x}\``).join(', ')}`);
      out.push('');
    } else {
      out.push(`### \`<${e.name}>\`\n\n${e.attrs.map((x) => `\`${x}\``).join(', ')}. ${md(e.doc.charAt(0).toUpperCase() + e.doc.slice(1))}.\n`);
    }
  }
  out.push(`## Names available in expressions

- **Magic names:** ${ALL_MAGIC.map((m) => `\`${m}\``).join(', ')}.
- **Store functions:** ${STORE_FNS.map((f) => `\`${f}()\``).join(', ')}.
- **Built-in helpers:** ${BUILTIN_HELPERS.map((h) => `\`${h}()\``).join(', ')}.
`);
  return out.join('\n');
}

function check(path: string, content: string) {
  const file = resolve(root, path);
  if (update) { writeFileSync(file, content); return; }
  let current = '';
  try { current = readFileSync(file, 'utf8'); } catch { /* missing */ }
  expect(current, `${path} is stale: run \`npm run docs\``).toBe(content);
}

test('llms.txt is current', () => check('llms.txt', llms()));
test('docs/attributes.md is current', () => check('docs/attributes.md', attributes()));
test('docs/diagnostics.md is current', () => check('docs/diagnostics.md', diagnostics()));
// a marker a server writes on its error body (sinter-axum), not an attribute developers write: kept out of
// what tells developers and models which attributes exist
test('`data-sn-failed` is in neither llms.txt nor the editors\' custom data', () => {
  expect(llms()).not.toContain('data-sn-failed');
  expect(customData()).not.toContain('data-sn-failed');
});
test('html-custom-data.json is current', () => check('html-custom-data.json', customData()));
test('the VS Code extension\'s custom data is current', () => check('editors/vscode/html-custom-data.json', customData()));
test('every recipe has a test', () => {
  const html = readdirSync(recipes).filter((f) => f.endsWith('.html')).map((f) => f.replace(/\.html$/, ''));
  expect(html.sort()).toEqual(RECIPES.map((r) => r[0]).sort());
  for (const r of html) expect(readdirSync(recipes)).toContain(`${r}.test.ts`);
});
