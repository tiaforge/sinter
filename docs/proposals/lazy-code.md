# Proposal: lazy code

Status: accepted (2026-11-11), reviewed by the Caley session. Nothing is implemented yet.

Decided with the user:
- sinter solves this itself; a guardrail alone is not enough.
- When code loads is said per page, in the markup.
- Deploy skew is detected, not prevented by keeping old assets on the server.
- Heavy code is declared by naming the package in the config (`sinter({ lazy })`), not in the actions
  module.
- Every timing is an attribute in the markup, so a page that does not write its head can ask for any
  of them; component scripts are covered.
- Attribute names: `data-sn-import` (run when rendered) and `data-sn-preload` (fetch with the page).
- A use of a lazy package other than an awaited call is an error outside component scripts.
- Every component script that imports a lazy package becomes lazy (one rule, nothing for the type
  checker to explain).
- A stale chunk is `$error.stale = true`, not a status and not a general `$error.kind`. `status`
  cannot carry it: the chunk's 404 would read like an API's 404 (no such item), an invented status
  would be a magic number in a field that holds HTTP statuses, and a host's `200.html` answer has no
  meaningful status at all. `0` (network) and `null` (thrown) keep their meaning for lazy loads.

## The case

Caley's mail, settings and calendar pages use openpgp (132 kB gzip). None of them may ship it in the
page bundle. Settings and calendar load it on first use; the mail pages fetch it right after takeover
(measured on a throttled network with 4x CPU: no slower page, and openpgp ready 300–1400 ms sooner than
with an idle callback). Today this is all app code:

- `loadPgp = lazyModule(() => import('./modules.ts'))`, awaited in 13 actions, and a second lazy entry
  (`vault-steps.ts`);
- a rule in Caley's CLAUDE.md that nothing checks: no static import of openpgp, or of a module that
  imports it, from page code;
- `<pgp-preload>`, a component whose script calls `loadPgp()` on connect;
- deploy skew (an open tab asks for a chunk the new deploy removed) handled for openpgp only.

The opposite case matters too. In RealWorld with `embed`, loading marked and DOMPurify lazily made the
article slower (LCP 888 → 1,088 ms), because the first content needs them. So the package is what is
lazy, but when it loads depends on the page.

Heavy code in a web app is nearly always a package: openpgp, a markdown parser, a sanitizer, a chart
or map library, a PDF renderer. The app's own modules around it are small. So the split is made at the
package.

## What sinter has to build on

- Actions and `call` resources are async in the markup already: `aria-busy`, `$meta`, `then`/`catch`
  and `$error` cover the time a load takes. sinter needs no new loading state (Solid's `lazy()` needs
  Suspense; sinter does not).
- The plugin already transforms app modules, and `sinter check` and the LSP already read the plugin's
  options from the Vite config (`viteProject`).
- The build already logs each page's chunk and imports in gzip.

## Design

### 1. A lazy package, named in the config

```ts
// vite.config.ts
sinter({ lazy: ['openpgp'] })
```

App code imports the package as it always has:

```ts
// src/lib/pgp/compose.ts
import * as openpgp from 'openpgp';
import type { PrivateKey } from 'openpgp';

export async function encryptTo(keys: PrivateKey[], text: string) {
  const message = await openpgp.createMessage({ text });
  return openpgp.encrypt({ message, encryptionKeys: keys });
}
```

- **The transform.** In every app module (not in `node_modules`), the plugin points imports of
  `openpgp` at a module it generates, `virtual:sinter-lazy/openpgp`. That module exports, under the
  package's own export names, one async stub per export: `encrypt = (...a) => load().then((m) =>
  m.encrypt(...a))`. `load()` is one `import('openpgp')` shared by every stub, so Rolldown puts the
  package in its own chunk, and it is loaded once. A namespace import (`import * as openpgp`) and named
  imports (`import { encrypt }`) both work, since the generated module has the same names.
- **Allowed uses.** A value imported from a lazy package may only be called: `openpgp.encrypt(…)`,
  `encrypt(…)`. Type-only uses are erased and allowed (`import type`, a type annotation). Anything else
  is `SN324` at its line, since it needs the package loaded at once (except in a component script,
  which loads with the package: section 3):
  - `instanceof`, `new`, reading a constant or setting (`openpgp.enums`, `openpgp.config.x = …`);
  - passing the namespace or a function as a value (`keys.map(openpgp.readKey)`);
  - `import 'openpgp'` for its side effects, `export … from 'openpgp'`.
- **Every call is awaited.** A stub returns a Promise, also for a function that is sync in the package
  (`marked.parse(md)`, `DOMPurify.sanitize(html)`, a library's `renderGraph(el, data)`). So a call is
  allowed only where its result is waited for: the operand of `await`, returned, or chained with
  `.then`. Any other call is `SN324`. Without the rule, a forgotten `await` would leave a Promise where
  TypeScript sees a string. With it, sync and async exports are both allowed (`const html = await
  marked.parse(md)`), the check is syntactic (the plugin, `sinter check` and the LSP run the same
  one), and nothing reads the package's types. Each call is checked on its own: in `await
  openpgp.verify({ message: await openpgp.createMessage(…), signature: await openpgp.readSignature(…) })`
  (Caley's `keyring.ts`) all three are awaited.
- **Types are no edge.** `import type`, `export type { … } from`, and imports used only as types are
  erased: the transform leaves them, and neither the helper check nor the component rule nor `SN325`
  follows them (Caley's `sinter.types.ts` re-exports types from `lib/pgp/*`).
- **What the calls return is real.** `const key = await openpgp.readKey(…)` is the package's own
  object, so its methods (`key.getFingerprint()`) are ordinary sync calls.
- **Not in helpers.** Helpers run synchronously while a binding renders, so they cannot wait for a
  download: a helper module that reaches a lazy package, directly or through app modules, is `SN324`,
  with the import chain. Compute the value in
  an action or a `<sn-resource call>`, or do not make the package lazy: when the first content needs it,
  loading it with the page was faster (RealWorld above).
- **Blocking work still blocks.** Lazy loading moves the download, not the CPU time a call takes once
  the package is there.
- **Subpaths.** `lazy: ['openpgp']` covers `openpgp/lightweight` too; each subpath is its own chunk.
- **Everything else is unchanged.** The app's own modules around the package (Caley's `lib/pgp/*`) stay
  in the page bundle; they are small, and the build log shows them. The page module and the actions
  module are not touched: an action that awaits openpgp now waits for the download the first time, and
  its element is busy meanwhile.
- **Tests.** With the plugin (vitest with the Vite config), tests get the stubs; without it, the real
  package. Both behave the same, since every call is awaited.
- **The app's own heavy modules.** These are not covered, and a plain `import()` stays the way to split
  them. The guardrail and the stale check (sections 4 and 5) apply to those `import()`s too.

For Caley: `sinter({ lazy: ['openpgp'] })`, then delete `loadPgp`, `lazyModule`, `modules.ts`, the 13
awaits and the CLAUDE.md rule. Its runtime uses of openpgp are all awaited or returned calls
(`createMessage`, `encrypt`, `decrypt`, `decryptKey`, `sign`, `verify`, `readKey(s)`,
`readPrivateKey`, `readMessage`, `readSignature`, `generateKey`, `reformatKey`,
`createCleartextMessage`), and `PrivateKey`, `PublicKey`, `Key` and `Message` appear only as types
(checked 2026-11-11, tests excluded).

### 2. When it loads: in the markup, per page

There are three timings. The default needs nothing; the two others are attributes on an element, in a
page, its layout or a component, so a page that does not write its head can still ask for either.

| When | Markup | What the build or runtime does |
| --- | --- | --- |
| on first call (default) | nothing | the first stub called loads the package |
| when an element is rendered | `data-sn-import="openpgp"` | the page module loads and runs the package when the element is rendered: at takeover for an element outside templates; when its `data-sn-if` branch or row is first rendered otherwise. Never earlier than takeover: an element the early script or prerendering wrote counts at takeover, so the load does not compete with the page's own files |
| with the page | `data-sn-preload="openpgp"` | the build adds `<link rel="modulepreload">` to the page's head, for the package's chunk and each chunk it imports (in dev, the package's pre-bundled module). The browser fetches and compiles it in parallel with the page bundle; it runs at the first call, or where a `data-sn-import` says |

The two attributes are the two steps of loading a module: `preload` fetches it early, `import` runs it.
An element may have both.

For Caley: settings and calendar write nothing. `<mail-reader>`'s markup gets
`data-sn-import="openpgp"` on its root, which replaces `<pgp-preload>`, and every page using the
component inherits it. Whether the mail pages would be faster with `data-sn-preload` as well (fetched in
parallel with the page bundle instead of after takeover) is worth measuring then; it is one attribute
more. On a slow network a 132 kB preload competes with the page bundle, which is why the two are
separate.

- The value is a list of packages from `sinter({ lazy })`: `data-sn-import="openpgp, marked"`. Any
  other name is an error with a suggestion (`sinter check` and the LSP read the list from the Vite
  config).
- The attributes take no expression. A condition is expressed by where the element is, inside a
  `data-sn-if`.
- `data-sn-preload` counts wherever it is in the page's markup after components and the layout are
  expanded, inside a `data-sn-if` or `data-sn-for` template too: it says the page may need the package,
  and the build writes the link once per page. Written in a component, it applies to every page that
  uses the component; in a layout, to every page of the layout.
- A load an attribute starts that fails is silent. The call that needs the package reports it
  (section 5).

These follow Astro's island directives (`client:load`, `client:visible`), which say on the element
when its code loads. Here they are about a package, not a component.

### 3. Components

A component script is app code, so the transform applies to it: a script that calls openpgp in
`connected()` or in an event handler gets the stubs, and the attributes above work in component markup.

That is not enough for a component built around a library's classes, the usual heavy component:
`new Chart(…)` in [islands.md](../islands.md)'s `task-ring` is a use other than a call (`SN324`). So:

**A component script that imports a lazy package, directly or through app modules, becomes lazy
too.** The page module does not import it; the runtime does, when an instance is first rendered, and
the script runs once both it and the package have arrived. Inside such a script any use of the package
is allowed, since the package is there before the script runs.

The script and the package stay apart. The build puts each lazy package in a chunk of its own (one
chunk group per package) and each lazy script in its own small chunk:

```
task-ring-<hash>.js     2 kB   ─┐
burndown-<hash>.js      3 kB   ─┼─▶  chart.js-<hash>.js   68 kB   (one copy, shared)
kpi-spark-<hash>.js     1 kB   ─┘
```

- Three very different components on one page download chart.js once; the first one rendered starts
  it, the others find it loaded or loading.
- A page with only `task-ring` downloads task-ring's chunk and chart.js, not the other components'
  scripts.
- The two downloads start together: the build lists the package's chunk as a dependency of the
  script's chunk, so the browser does not wait for the script to learn it needs the package.
- A deploy that changes a component's script but not the package changes only the script's chunk: a
  visitor's cached copy of the package stays good.

```ts
// src/components/task-ring.ts: unchanged; `lazy: ['chart.js']` in the config
import Chart from 'chart.js/auto';
export class TaskRing extends TaskRingComponent {
  connected() { this.#chart = new Chart(this.refs.canvas, { … }); }
  …
}
```

- The component's markup does not wait: it is expanded at build time and rendered (early, prerendered
  or by the page module) as before. Only the script waits.
- The lifecycle stays whole. `connected()` runs once the script has loaded, with the current props.
  Props that changed during the load are in `this.props` then, so the first `propsChanged()` comes
  after `connected()`. An instance removed before the load ends never runs.
- Until then the script's own effects are missing: its `this.state` writes, its events, what it draws.
  Write the markup so that it reads well without them, as it should for a browser without JavaScript.
- Timings: by default, when the first instance is rendered. `data-sn-preload="chart.js"` in the
  component's or the page's markup preloads the package and the lazy scripts of the page's components that import it.
- A script that only calls the package's functions (Caley's components that call openpgp) becomes
  lazy the same way: the rule is about imports (decided). A script with other work to do at once keeps
  running at once by reaching the package only through `await import('./its-pgp-calls.ts')`, which is
  not an import in this sense.
- Islands (custom elements the app defines) are imported by the app, not by sinter, so they keep the
  stubs and `SN324`; the message suggests `await import()` in the element, or a component with a script.

### 4. The guardrail

The transform makes every import of the package from app code lazy, so app code cannot undo the split.
Two ways remain, and the build fails on both with the import chain (`SN325`, at `generateBundle`, from
Rolldown's module graph):

- **Another package imports it.** A page's static graph (its entry chunk, every chunk it imports, its
  early files) contains the lazy package because some other package depends on it:

  ```
  SN325 src/pages/mail.html: the page bundle contains openpgp (131.8 kB gzip), which sinter({ lazy }) loads lazily
    src/pages/mail.html → src/lib/pgp/autocrypt.ts → some-autocrypt-lib → openpgp
  ```

  The fix is to add that package to `lazy` as well, or to load it with `import()`.
- **An app module the app loads with `import()` is also imported statically by a page.** Vite already
  warns about this ("dynamically imported by … but also statically imported by …, dynamic import will
  not move module into another chunk"). For pages, sinter makes it an error.

The per-page log line gains each page's lazy chunks and their gzip sizes, so the cost a page defers
shows next to what it ships. The build log also names each lazy component script with the import
chain that made it lazy, so a later innocent import (a shared module starting to import one that
imports openpgp) does not delay a component's `connected()` unnoticed.

### 5. Deploy skew: detected, reported as an action error

An open tab whose deploy has been replaced asks for a chunk that no longer exists. sinter turns that
into an error the page can show:

1. A lazy load fails: a stub's `import()`, or an `import()` in app code, through Vite's
   `vite:preloadError`.
2. The runtime requests the chunk's URL again (`cache: 'no-store'`). The plugin writes each lazy
   package's chunk URL into its generated module at `renderChunk`, since the browser's error does not
   always say which URL failed (Safari names none).
   - A 404 or 410, or a 200 that is not JavaScript (a host serving `200.html` for every missing path),
     means stale.
   - A network error means the network: `status: 0`, as for any request.
   - A 200 with JavaScript means the module itself threw: `status: null` with the thrown error.
3. The action fails with `$error.stale = true` and the message "this page is out of date: reload it".
   The markup shows it with the action's `catch`, or the unhandled-error path shows it: the flag is on
   the error in `sn-error`'s `detail` too, so a page can show one banner for every stale load.
   `message` is English, as for sinter's other errors; an app in several languages shows its own text
   from the flag (`$error.stale ? m.page_outdated() : …`).

sinter never reloads by itself: the page may hold a draft. A failed load is not cached, so the next
call tries again. Every navigation in a sinter app loads a page, so skew only affects a tab that stayed
open across a deploy.

- No build id and no server-side file: the probe needs only the chunk's URL, and keeps nothing old on
  the server.
- `sinter-axum` needs no change: `ServeDir` already answers 404 for a removed file.

## Not in this proposal

- **The app's own heavy modules.** These stay a plain `import()`, with the guardrail and the stale
  check. A `.lazy.ts` file convention, with the same stubs, could be added if a case comes up.
- **Running a package in a worker** (calls through `postMessage`). This would also take decryption off
  the main thread, but arguments must be cloneable. Keep it for when decryption time, not download
  time, is the problem.
- **Splitting every handler automatically** (Qwik, Marko). sinter already ships only what a page uses,
  and heavy code arrives as a few whole packages, which a list describes better.
- **`import defer`** (standards track) delays running a module, not downloading it.

## Plan

1. `sinter({ lazy })`, the generated module and the transform; `SN324` (a use other than an awaited
   call, a helper module importing the package) in the plugin, `sinter check` and the LSP.
2. `data-sn-import` and `data-sn-preload` (build and dev); `sinter check` and the LSP read the list.
3. Component scripts that load with the package: the compiler's script imports, the runtime's
   lifecycle while loading, testing's `render()` (which awaits the scripts before it returns).
4. The guardrail (`SN325`) and the log line.
5. The stale probe and `$error.stale`, for stubs, lazy component scripts and `vite:preloadError`.
6. Docs (a guide page; first-paint.md on the three timings; islands.md; diagnostics), the changelog.
   Move Caley to `lazy: ['openpgp']` with `data-sn-import` on `<mail-reader>` (in the Caley session),
   only once step 5 is in: deleting `lazyModule` removes Caley's own text for a failed openpgp load.
   Measure the mail pages with and without `data-sn-preload` (Caley expects it to be slower on slow
   links).

Reviewed by the Caley session (2026-11-11) against its code: no blockers. Its points are in the text
above: nested awaited calls, types as no edge, the transitive helper check, the log of lazy component
scripts, no load before takeover, the flag in `sn-error`, and migrating Caley with step 5. Expected
for Caley: about 8–9 kB gzip of its own pgp code moves into the mail and settings bundles, openpgp
(129.7 kB) leaves them, and the settings `vault` resource may render without openpgp, since only calls
that reach it load it.
