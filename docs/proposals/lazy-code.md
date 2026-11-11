# Proposal: lazy code

Status: proposal (2026-11-11), for review. Nothing is implemented.

Decided with the user: sinter solves this itself (a guardrail alone is not enough); when code loads is
said per page, in the markup; deploy skew is detected, not prevented by keeping old assets on the
server.

## The case

Caley's mail, settings and calendar pages call openpgp (132 kB gzip). None of them may ship it in the
page bundle. Settings and calendar load it on first use; the mail pages fetch it right after takeover
(measured on a throttled network with 4x CPU: no slower page, and openpgp ready 300–1400 ms sooner than
with an idle callback). Today this is all app code:

- `loadPgp = lazyModule(() => import('./modules.ts'))`, awaited in 13 actions;
- a rule in Caley's CLAUDE.md that nothing checks: no static import of openpgp, or of a module that
  imports it, from page code;
- `<pgp-preload>`, a component whose script calls `loadPgp()` on connect;
- deploy skew (an open tab asks for a chunk the new deploy removed) handled for openpgp only.

The opposite case matters too. In RealWorld with `embed`, loading marked and DOMPurify lazily made the
article slower (LCP 888 → 1,088 ms), because the first content needs them. So whether code is lazy is
decided by the module, but when it loads depends on the page.

## What sinter has to build on

- The compiler writes each page's imports and imports only the actions the page calls, each namespace
  from the module that declares it (`src/compiler/index.ts`). Making one of them lazy changes one
  import line and one runner.
- Actions and `call` resources are async in the markup already: `aria-busy`, `$meta`, `then`/`catch`
  and `$error` cover the time a load takes. sinter needs no new loading state (Solid's `lazy()` needs
  Suspense; sinter does not).
- The build already logs each page's chunk and imports in gzip, and `earlyBudget` already names the
  largest modules of the early files.

## Design

### 1. A lazy namespace, declared in the actions module

```ts
// src/sinter.actions.ts
import { lazy } from '@tiaforge-ui/sinter';
export * as mail from './actions/mail.ts';
export const pgp = lazy(() => import('./actions/pgp.ts'));
```

```html
<button data-sn-call="pgp.encrypt(draft)">Send encrypted</button>
<sn-resource name="body" call="pgp.decrypt(open)" when="open"></sn-resource>
```

- The markup is the same as for an eager namespace. The first call loads the module; the load is part
  of the action, so `aria-busy` and `$meta.body.loading` are true while it runs.
- `lazy()` returns an object with one async function per export of the module. App code uses it too:
  an action in `mail.ts` that needs openpgp awaits `pgp.decrypt(…)` instead of importing it. That
  removes the 13 `await loadPgp()` calls, and tests call the same object.
- The module reader recognises exactly this shape: an exported `const` initialised with `lazy(() =>
  import('<literal>'))`. Its members are the target module's exported functions, read as for
  `export * as`. An export that is not a function cannot be lazy: it is a compile error naming the
  export.
- Types: `lazy<M>(load: () => Promise<M>): Lazy<M>`, where `Lazy<M>` maps each function to the same
  parameters returning `Promise<Awaited<R>>`. `sinter check` types arguments and `$result` from that,
  with nothing sinter-specific.
- The page module imports `pgp` from the actions module as it imports other actions; the target
  module is reached only through the `import()`, so Rolldown puts it in its own chunk.
- The load is cached. A failed load is not, so the next call tries again (Caley's `lazyModule` today).

Why here rather than in `sinter({ lazy: [...] })`: a config entry would make only the markup's calls
lazy. App code calling openpgp from another action would still need its own `import()`. `sinter check`
and the LSP would also have to read the Vite config. The `lazy()` value is plain JavaScript: it works the
same in dev, the build, vitest and the type checker.

### 2. When it loads: in the markup, per page

There are three timings. The default needs nothing; the two others are written where the need is.

| When | Markup | What the build or runtime does |
| --- | --- | --- |
| on first call (default) | nothing | `import()` when an action or resource first calls a member |
| when an element is rendered | `data-sn-import="pgp"` on that element | the runtime starts the load when it renders the element: at takeover for an element outside templates; when its `data-sn-if` branch or row is first rendered otherwise |
| with the page | `<link rel="modulepreload" data-sn-import="pgp">` in the head | the build fills `href` with the chunk, plus one link for each chunk it imports; in dev, the source module |

For Caley: settings and calendar write nothing. `<mail-reader>`'s markup gets `data-sn-import="pgp"` on
its root, which replaces `<pgp-preload>`, and every page using the component inherits it. Whether the
mail pages would be faster with the head link (fetched in parallel with the page bundle instead of
after takeover) is worth measuring then; it is one line to switch.

- The value is a list of lazy namespaces: `data-sn-import="pgp, charts"`. A name that is not exported
  is `SN310`. A namespace that is not lazy is an error too, since writing it would do nothing.
- The attribute takes no expression. A condition is expressed by where the element is, inside a
  `data-sn-if`.
- A load the attribute starts that fails is silent. The call that needs the module reports it (below).
- The head link is evaluated by the browser only when the first call imports the module: it fetches
  and compiles, but runs nothing.

These follow Astro's island directives (`client:idle`, `client:visible`), which say on the element
when its code loads. Here they are about a namespace, not a component.

### 3. The guardrail

The build fails when a page's static graph (its entry chunk and every chunk it imports, and its early
files) contains a heavy module that a lazy namespace reaches, and prints the import chain:

```
SN324 src/pages/mail.html: the page bundle imports openpgp (131.8 kB gzip), which `pgp` loads lazily
  src/pages/mail.html → src/components/mail-reader.ts → src/lib/pgp/format.ts → openpgp
```

It runs at `generateBundle`, from Rolldown's module graph. It runs in builds only: in dev, Vite has no
chunks to compare.

What counts as heavy is open (decision 3). A lazy module and a page may share small modules (a
formatter, a type guard), and that must not fail the build.

The per-page log line gains each page's lazy chunks and their gzip sizes, so the cost a page defers
shows next to what it ships.

### 4. Deploy skew: detected, reported as an action error

An open tab whose deploy has been replaced asks for a chunk that no longer exists. sinter turns that
into an error the page can show:

1. A lazy load fails.
2. The runtime requests the chunk's URL again (`cache: 'no-store'`). The plugin gives `lazy()` its
   chunk's URL at `renderChunk`, since the browser's error does not always say which URL failed (Safari
   names none).
   - A 404 or 410, or a 200 that is not JavaScript (a host serving `200.html` for every missing path),
     means stale.
   - A network error means the network: `status: 0`, as for any request.
   - A 200 with JavaScript means the module itself threw: `status: null` with the thrown error.
3. The action fails with `$error.stale = true` and the message "this page is out of date: reload it".
   The markup shows it with the action's `catch`, or the unhandled-error path shows it.

sinter never reloads by itself: the page may hold a draft. Since every navigation in a sinter app loads
a page, skew only affects a tab that stayed open across a deploy.

- No build id and no server-side file: the probe needs only the chunk's URL, and keeps nothing old on
  the server.
- `sinter-axum` needs no change: `ServeDir` already answers 404 for a removed file.
- The same probe works for Vite's own `import()` calls in app code, through `vite:preloadError`. Caley's
  `vault-steps.ts` keeps working that way until it moves to `lazy()`.

## Not in this proposal

- Lazy component scripts (an island's module loaded when the element first renders). The islands
  runtime already handles an element defined late, and `data-sn-import` could later take a component
  name. Caley has no heavy component yet.
- Running a namespace in a worker (calls through `postMessage`). This would also take decryption off
  the main thread, but arguments must be cloneable and `ctx.request` does not cross. Keep it for when
  decryption time, not download time, is the problem.
- Splitting every handler automatically (Qwik, Marko). sinter already ships only what a page uses, and
  heavy code arrives as a few whole libraries, which a declaration describes better.

## Decisions for review

1. **Declaration:** `lazy(() => import(…))` in the actions module (recommended), or
   `sinter({ lazy: [...] })` in the config.
2. **Markup:** `data-sn-import` on an element (when it is rendered) plus the `<link rel="modulepreload"
   data-sn-import>` head form (with the page). Other names to consider: `data-sn-preload`,
   `data-sn-load`.
3. **What counts as heavy for the guardrail:**
   - (a) any module of the lazy namespace's graph over a size (say 10 kB minified), recommended;
   - (b) only packages from `node_modules`;
   - (c) anything at all, with an allowlist.
4. **The stale error:** `$error.stale` (recommended: it adds one field), or a general `$error.kind`
   (`'http' | 'network' | 'action' | 'stale'`), which would touch every error path.
5. **Scope:** lazy actions and resources only (recommended), or lazy component scripts in the same step.

## Plan

1. `lazy()` and `Lazy<M>`; the module reader, the compiler and `sinter check` for lazy namespaces;
   testing's `render()` with a lazy namespace.
2. `data-sn-import` on elements, then the head link (build and dev).
3. The guardrail and the log line.
4. The stale probe and `$error.stale`, with `vite:preloadError`.
5. Docs (actions.md, a section in first-paint.md on the three timings), the changelog. Move Caley's
   openpgp to `pgp = lazy(…)` with `data-sn-import` on `<mail-reader>` (in the Caley session), and
   measure the mail pages with the after-takeover and the with-the-page timings.
