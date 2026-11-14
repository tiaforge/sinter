# Testing

`@tiaforge-ui/sinter/testing` compiles your page with the real compiler, mounts it in the test DOM, and lets you drive requests, server events and time. A test sits next to the markup and needs no browser.

```js
import { test, expect } from 'vitest';
import { render, mockRequests } from '@tiaforge-ui/sinter/testing';
import page from './contacts.html?raw';

test('delete is optimistic and rolls back on failure', async () => {
  const requests = mockRequests({
    'GET /api/contacts': { contacts: [{ id: 1, name: 'Ada' }] },
    'DELETE /api/contacts/1': { status: 500 },
  });
  const { root, flush, settle } = await render(page, { requests });
  await settle();

  root.querySelector('button').click();
  await flush();                                  // optimistic change applied
  expect(root.querySelectorAll('li')).toHaveLength(0);

  await settle();                                 // request failed, change rolled back
  expect(root.querySelectorAll('li')).toHaveLength(1);
});
```

The module imports no test runner. Use Vitest or anything else, on jsdom or happy-dom. The page is compiled as a build compiles it, build-time constants included ([first paint](first-paint.md)): what nothing on the page writes is in the HTML, a `data-sn-if` it decides is its branch, and a loop over a constant list is its rows. Compile errors fail the test with the same messages as the build.

## render

`render(html, options)` returns a promise of:

| Field | Purpose |
| --- | --- |
| `root` | the document body |
| `app` | the mounted app |
| `state(el)` | the nearest `data-sn-state` scope of `el`: `get()` and `update(fn)`, [below](#changing-state) |
| `flush()` | run the scheduler until no binding is dirty. Deterministic, no timeouts |
| `settle()` | `flush()` until every request, queue and debounce has finished |
| `advance(ms)` | move sinter's clock: debounce, backoff, `$now` |
| `navigations` | URLs sinter tried to go to, such as a login redirect. The test DOM never navigates |
| `url()` | the current page URL, after `$url` writes |
| `history()` | the page's history entries, oldest first: a `$url` write a user's event caused pushes one, other writes replace the current one |
| `back()`, `forward()` | move through `history()` and dispatch `popstate`, as the browser's buttons do; nothing happens past either end. A navigation adds no entry, so they never leave the page |
| `visibility('hidden' \| 'visible')` | hide or show the page like a background tab |
| `window(type, props)` | dispatch `pagehide`, `pageshow`, `popstate`, `online`, `beforeunload`, `pageswap` or `pagereveal` |
| `frame()` | with `frames`, run what waits for the next animation frame |
| `warnings()` | the runtime's warnings and errors since `render()`: `{ code, message, error, environment }` |

The events a test dispatches (`click()`, `dispatchEvent(new Event('input'))`) count as the user's, so
their `$url` writes push a history entry; the custom events sinter dispatches itself (`emit`,
`sn-error`) do not.

A full document keeps its `<html>` attributes (`lang`, `data-sn-state`, `data-sn-persist`, bindings), as in the browser. Each `render` replaces the previous page.

| Option | Purpose |
| --- | --- |
| `requests` | a `mockRequests(...)` middleware |
| `streams` | stream URL to `mockStream()`. A URL without a mock uses `configure({ transport })`, so a custom transport can be tested over a fake connection |
| `url` | the page URL, for `$url` (default `http://localhost/`) |
| `locale` | the locale for `$locale` and the formatters |
| `now` | start time of the clock, a number or `Date` |
| `helpers`, `actions` | your helper and action functions; namespaces are objects of functions |
| `files` | other files the page reads, by path relative to the page |
| `components` | the app's components by name: `{ 'article-preview': '<template data-sn-component="…">…</template>' }` |
| `layouts` | the app's layouts by name: `{ 'app-layout': '<!doctype html><html data-sn-layout="{ title: string }">…</html>' }`. A page that is only a layout's tag renders merged with it ([layouts](layouts.md)) |
| `scripts` | the scripts of components by name: the module (`await import('../src/components/task-ring.ts')`) or the class |
| `storage`, `session` | `localStorage` and `sessionStorage`. Pass the same `memoryStorage()` to two renders to test what carries over between page loads |
| `messages` | built-in messages as the files hold them, base language first: `{ en: {...}, de: {...} }` |
| `firstPaint` | `true` or `{ early, afterEarly }`: run the early script before mounting, [below](#firstpaint) |
| `frames` | server-event changes wait for `frame()` instead of flushing in a microtask |
| `pages` | your other pages by file name, so links to them prefetch their data as in a build |
| `apis`, `defaultApi` | the app's APIs as `sinter({ apis })` takes them, each `openapi` a parsed document: paths on the page are relative to them, requests carry their credentials and headers ([docs/apis.md](apis.md#in-tests)) |
| `openapi` | a parsed OpenAPI document, as the older `sinter({ openapi })` gives the compiler |
| `remoteImages`, `css` | `images.remote` and the page's CSS, for pages with bound images |
| `strict` | `true` or `{ allow }`: the page's warnings throw and a runtime warning rejects the call that ran it; default `SINTER_STRICT`, which `false` overrides ([docs/strict.md](strict.md#in-tests)) |

Pass your real helpers and actions rather than copies:

```js
import * as helpers from './src/sinter.helpers.js';
const { root } = await render(page, { requests, helpers });
```

Requests from the app's `configure({ request })` still run, before the mock.

### Changing state

Drive the page as a user would where you can: click the button whose handler writes the state. For a change that takes many steps, `state(el).update(fn)` writes the scope around `el` directly and re-renders all of it:

```js
const { root, state, flush } = await render(`<ul data-sn-state="{ items: [] }">
  <template data-sn-for="it in items"><li data-sn-text="it.v"></li></template>
  <button data-sn-on-click="items = []">clear</button></ul>`);
state(root.querySelector('ul')).update((s) => { s.items.push({ v: 1 }); });
await flush();
```

It stands for what the page writes, so it writes only what the page writes too. A field nothing on the page writes (no handler, model, action or component script) is a constant in the build: its first value is in the HTML and no binding follows a change. `update()` throws for one, naming it. A page has no `state()`: in the browser, state changes through handlers and a component script's `this.state`.

## mockRequests

`mockRequests(routes)` answers requests from a table of `'METHOD /path'` routes. A route is one of:

| Route value | Response |
| --- | --- |
| an object, array, string, number, `null` | 200 with that as JSON (`null`: 204) |
| `{ status, body, headers }` | that status, with `body` as JSON or text |
| `(call) => value` | computed from the request; may be async; its return value is read as above |

A route with `?` in its path matches the whole path and query string, else only the path:

```js
const requests = mockRequests({
  'GET /api/contacts': { contacts: [] },
  'GET /api/contacts?page=2': { contacts: [{ id: 9, name: 'Zed' }] },
  'POST /api/contacts': (call) => ({ id: 10, ...call.body }),
  'PUT /api/contacts/1': { status: 422, body: { errors: { name: 'Required' } } },
});
```

| Member | Purpose |
| --- | --- |
| `calls` | every request, in order: `{ method, url, path, body, headers, status }`. `body` is parsed JSON, `FormData` or text; `status` is the response's, once answered |
| `pending` | requests waiting to be answered |
| `deliver()` | answer every waiting request now; returns how many |
| `errors` | errors for unmatched requests |

Responses are held until `settle()` (or `deliver()`), so you can assert what the page shows while a request is in flight. A request no route matches fails the test and lists the registered routes.

```js
expect(requests.calls.at(-1)).toMatchObject({ method: 'DELETE', path: '/api/contacts/1' });
expect(requests.calls.at(-1).body).toEqual({ id: 1 });
```

## mockStream

`mockStream()` stands in for a `<sn-sync>` connection:

```js
import { render, mockRequests, mockStream } from '@tiaforge-ui/sinter/testing';

const stream = mockStream();
const { root, settle, flush } = await render(page, {
  requests: mockRequests({ 'GET /api/contacts': { contacts: [] } }),
  streams: { '/api/events': stream },
});
await settle();

stream.emit('contact_updated', { contact: { id: 2, name: 'Grace' } });
await flush();
expect(root.querySelectorAll('li')).toHaveLength(1);

stream.drop();                    // a network error: sinter reconnects and refetches
```

| Member | Purpose |
| --- | --- |
| `emit(name, payload)` | deliver a server event. The payload goes through JSON, as over the wire. Throws while disconnected |
| `drop()` | drop the connection as a network error would |
| `connected` | whether the page is connected |

## Time

Debounces, backoff, `refresh` and `$now` run on sinter's clock, which only moves when you move it:

```js
const { advance } = await render(page, { requests, now: Date.parse('2026-01-01T09:00:00Z') });
await advance(30_000);            // runs a refresh="30s" resource
```

`settle()` runs debounces on its own. A request waiting between retries runs again only when you `advance`.

## firstPaint

`firstPaint(html, options)` shows the page as the browser does before the page module runs: build-time values written into the HTML, then the early script. Nothing is mounted, so bindings that wait for data stay as the HTML has them. It returns `{ root, html }`.

```js
import { firstPaint, memoryStorage } from '@tiaforge-ui/sinter/testing';

test('the saved menu state and language are in the first frame', async () => {
  const storage = memoryStorage();
  storage.setItem('locale', 'de');
  storage.setItem('sn:nav-collapsed', 'true');
  const { root } = await firstPaint(page, { messages, storage });
  expect(root.querySelector('input').checked).toBe(true);
  expect(root.querySelector('nav > span')).toBeNull();     // the name waits for its data
});
```

Options: `helpers`, `files`, `storage`, `messages`, `locale`, and `early`, a function standing for your `src/sinter.early.ts` that runs before the early bindings.

To check that mounting changes nothing visible, pass `firstPaint` to `render`. `afterEarly` runs between the early script and the mount:

```js
let shown = '';
const { root, settle } = await render(page, {
  requests,
  firstPaint: { afterEarly: () => { shown = document.querySelector('nav').outerHTML; } },
});
expect(root.querySelector('nav').outerHTML).toBe(shown);
```

See [docs/first-paint.md](first-paint.md).

## Messages

```js
const messages = {
  en: { inbox_title: 'Inbox' },
  de: { inbox_title: 'Posteingang' },
};
const { root, flush } = await render(page, { messages, locale: 'de' });
expect(root.querySelector('h1').textContent).toBe('Posteingang');
```

The locale is `locale`, else the stored choice (`locale` in `storage`), else the base language. `$locale = 'en'` in a handler switches. See [docs/configuration.md](configuration.md#messages) and [docs/recipes/messages.html](recipes/messages.html).

## Type-checking in tests

`checkPage` from `@tiaforge-ui/sinter/check` runs the type check on one page: [docs/type-checking.md](type-checking.md#in-tests).

## Tests that come with the recipes

Each page in [docs/recipes](recipes/) has a test file next to it using these functions, for form dialogs, pagination, optimistic updates, SSE and SignalR sync, offline drafts and more. Copying a recipe means copying its test.

## sinter render

`npx sinter render` runs `render()` from the command line on a page of your project, to see what it does with some data without writing a test or opening a browser. It is meant for coding agents debugging a page: one command answers "what did the page request, with which headers, and what did it show?"

```bash
npx sinter render incident.html --url /incidents/3 --api mocks.json --storage ops.token=abc --select "#status=open"
```

The page is compiled as `sinter check` compiles it, with the project's files: components, layouts, the APIs of `sinter({ apis })`, the helpers and actions modules, component scripts, and the config module, whose request middleware runs on every request (so a token it adds shows in the output). The modules are loaded with Vite, so TypeScript works.

| Option | |
| --- | --- |
| `--api mocks.json` | answers requests from a JSON object of `mockRequests` routes: `{ "GET /api/me": { "user": { … } }, "GET /api/incidents/3": { "status": 404 } }`. A request no route matches gets a 404 and is marked `(no mock)` |
| `--api http://localhost:3000` | sends the requests no mock answers to this backend, with their headers. Both may be given |
| `--url` | the page's URL (default: its own path). A URL the page does not answer at (its `data-sn-path` patterns) is pointed out |
| `--storage k=v`, `--session k=v` | localStorage and sessionStorage entries, repeatable |
| `--now`, `--locale` | sinter's clock and the page's language |
| `--show <selector>` | prints only that part of the page; `--raw` prints the markup unindented; `--json` the whole report as JSON |

Steps run in order after the page has loaded, each followed by what it changed: the requests it sent, history writes, the lines of the page that changed, and the resources whose state changed.

| Step | |
| --- | --- |
| `--click <selector>` | clicks the element |
| `--input <selector>=<text>` | sets the field and dispatches `input` |
| `--select <selector>=<value>` | picks the option and dispatches `input` and `change` |
| `--check <selector>`, `--submit <selector>` | toggles a checkbox or radio button; submits the form (or the element's form) |
| `--back`, `--forward` | moves through the history |
| `--wait 5s` | moves sinter's clock (debounce, `refresh`, `$now`) |
| `--emit <event>=<json>` | delivers a server event on the page's streams (`<sn-sync>`) |

```text
page      incident.html at /incidents/:id
url       /incidents/3
requests
  GET /api/me           Authorization: Bearer abc  → 200 (mock)
  GET /api/incidents/3  Authorization: Bearer abc  → 200 (mock)
rendered
  <body>
    <main>
      <h1></h1>
      …
state
  me        loading: false  error: null  value: {"name":"ada"}
  incident  loading: false  error: null  value: {"incident":{"id":3,"title":"Disk full"}}
            ← the value is the whole response: items="incident" stores its `incident`

step --select #status=closed
  history
    push /incidents/3?status=closed
  changed
    -     <span class="badge" data-sn-c="status-badge">open</span>
    +     <span class="badge" data-sn-c="status-badge">closed</span>
  state
    (unchanged)

warnings
  sinter: binding `text` on <h1> at incident.html:8:21 threw: Cannot read properties of null (reading 'title')
```

Components are expanded at build time, so their tags are not on the page: select inside one by its root, `[data-sn-c="status-badge"]`. The exit code is 1 when the page cannot be compiled or a step cannot run (no element matches), else 0.

It runs on jsdom, like the tests: install it in the project (`npm i -D jsdom`). There is no layout, no CSS and no real browser behaviour, so visual problems, network quirks and anything specific to one browser engine still need a browser.

`render()` gives tests the same information: `historyWrites()` lists every push and replace (`history()` shows only the entries), `diagnostics` the build's warnings, and each of `requests.calls` has its `status` once answered. `mockRequests(routes, { fallback })` answers the requests no route matches instead of failing them; a function route gets the `Request` as its second argument.

## Testing helpers and config

A helper is a plain function, so unit-test it without a page, and test that the handler applies it with `render`. Call `configure()` in a test to try a request middleware or transport, and reset what you set afterwards:

```js
import { configure } from '@tiaforge-ui/sinter';
afterEach(() => configure({ transport: null, sessionProbe: null, retry: null }));
```
