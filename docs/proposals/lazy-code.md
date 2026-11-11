# Proposal: lazy code

Status: proposal (2026-11-11), for review. Nothing is implemented.

Decided with the user:
- sinter solves this itself; a guardrail alone is not enough.
- When code loads is said per page, in the markup.
- Deploy skew is detected, not prevented by keeping old assets on the server.
- Heavy code is declared by naming the package in the config (`sinter({ lazy })`), not in the actions
  module.

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
  is `SN324` at its line, since it needs the package loaded at once:
  - `instanceof`, `new`, reading a constant or setting (`openpgp.enums`, `openpgp.config.x = …`);
  - passing the namespace or a function as a value (`keys.map(openpgp.readKey)`);
  - `import 'openpgp'` for its side effects, `export … from 'openpgp'`.
- **Only async functions.** A stub returns a Promise, so a sync function would change its meaning
  without notice. `sinter check` reads the package's types and reports `SN324` for each called export
  whose return type is not a Promise. Dev builds check the same at each first call, in case nothing ran
  `sinter check`.
- **Subpaths.** `lazy: ['openpgp']` covers `openpgp/lightweight` too; each subpath is its own chunk.
- **Everything else is unchanged.** The app's own modules around the package (Caley's `lib/pgp/*`) stay
  in the page bundle; they are small, and the build log shows them. The page module and the actions
  module are not touched: an action that awaits openpgp now waits for the download the first time, and
  its element is busy meanwhile.
- **Tests.** With the plugin (vitest with the Vite config), tests get the stubs; without it, the real
  package. Both behave the same, since everything called is async.
- **The app's own heavy modules.** These are not covered, and a plain `import()` stays the way to split
  them. The guardrail and the stale check (sections 3 and 4) apply to those `import()`s too.

For Caley: `sinter({ lazy: ['openpgp'] })`, then delete `loadPgp`, `lazyModule`, `modules.ts`, the 13
awaits and the CLAUDE.md rule. Its runtime uses of openpgp are all calls of async functions
(`createMessage`, `encrypt`, `decrypt`, `decryptKey`, `sign`, `verify`, `readKey(s)`,
`readPrivateKey`, `readMessage`, `readSignature`, `generateKey`, `reformatKey`,
`createCleartextMessage`), and `PrivateKey`, `PublicKey`, `Key` and `Message` appear only as types
(checked 2026-11-11, tests excluded).

### 2. When it loads: in the markup, per page

There are three timings. The default needs nothing; the two others are written where the need is.

| When | Markup | What the build or runtime does |
| --- | --- | --- |
| on first call (default) | nothing | the first stub called loads the package |
| when an element is rendered | `data-sn-import="openpgp"` on that element | the runtime starts the load when it renders the element: at takeover for an element outside templates; when its `data-sn-if` branch or row is first rendered otherwise |
| with the page | `<link rel="modulepreload" data-sn-import="openpgp">` in the head | the build fills `href` with the package's chunk, plus one link for each chunk it imports; in dev, the package's pre-bundled module |

For Caley: settings and calendar write nothing. `<mail-reader>`'s markup gets
`data-sn-import="openpgp"` on its root, which replaces `<pgp-preload>`, and every page using the
component inherits it. Whether the mail pages would be faster with the head link (fetched in parallel
with the page bundle instead of after takeover) is worth measuring then; switching is one line.

- The value is a list of packages from `sinter({ lazy })`: `data-sn-import="openpgp, marked"`. Any
  other name is an error with a suggestion (`sinter check` and the LSP read the list from the Vite
  config).
- The attribute takes no expression. A condition is expressed by where the element is, inside a
  `data-sn-if`.
- A load the attribute starts that fails is silent. The call that needs the package reports it
  (section 4).
- The head link is only fetched and compiled. It runs when the first call imports the package.

These follow Astro's island directives (`client:idle`, `client:visible`), which say on the element
when its code loads. Here they are about a package, not a component.

### 3. The guardrail

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
shows next to what it ships.

### 4. Deploy skew: detected, reported as an action error

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
   The markup shows it with the action's `catch`, or the unhandled-error path shows it.

sinter never reloads by itself: the page may hold a draft. A failed load is not cached, so the next
call tries again. Every navigation in a sinter app loads a page, so skew only affects a tab that stayed
open across a deploy.

- No build id and no server-side file: the probe needs only the chunk's URL, and keeps nothing old on
  the server.
- `sinter-axum` needs no change: `ServeDir` already answers 404 for a removed file.

## Not in this proposal

- **The app's own heavy modules.** These stay a plain `import()`, with the guardrail and the stale
  check. A `.lazy.ts` file convention, with the same stubs, could be added if a case comes up.
- **Lazy component scripts:** an island's module loaded when the element first renders. The islands
  runtime already handles an element defined late. Caley has no heavy component yet.
- **Running a package in a worker** (calls through `postMessage`). This would also take decryption off
  the main thread, but arguments must be cloneable. Keep it for when decryption time, not download
  time, is the problem.
- **Splitting every handler automatically** (Qwik, Marko). sinter already ships only what a page uses,
  and heavy code arrives as a few whole packages, which a list describes better.
- **`import defer`** (standards track) delays running a module, not downloading it.

## Decisions for review

1. **Attribute name:** `data-sn-import` (recommended). Alternatives: `data-sn-preload`, `data-sn-load`.
2. **Uses other than calls:** an error (recommended). The alternative is to let a constant through
   (`openpgp.enums`) by loading the package with the page wherever one is read. It is never needed in
   Caley, and it would quietly undo the split.
3. **The stale error:** `$error.stale` (recommended: it adds one field), or a general `$error.kind`
   (`'http' | 'network' | 'action' | 'stale'`), which would touch every error path.
4. **Scope:** lazy packages, the `import()` guardrail and the stale check (recommended); or lazy
   component scripts in the same step.

## Plan

1. `sinter({ lazy })`, the generated module and the transform; `SN324` for uses other than calls in
   the plugin, and for sync exports in `sinter check`, with the dev check at first call.
2. `data-sn-import` on elements, then the head link (build and dev); `sinter check` and the LSP read
   the list.
3. The guardrail (`SN325`) and the log line.
4. The stale probe and `$error.stale`, for stubs and for `vite:preloadError`.
5. Docs (a guide page; first-paint.md on the three timings; diagnostics), the changelog. Move Caley to
   `lazy: ['openpgp']` with `data-sn-import` on `<mail-reader>` (in the Caley session), and measure the
   mail pages with the after-takeover and the with-the-page timings.
