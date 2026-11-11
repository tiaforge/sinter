# Lazy packages

Some packages are too heavy to ship with every page: a crypto library, a chart or map library, a PDF
renderer. List them in the Vite config, and sinter loads each one on first use instead of with the page:

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

The build points every import of `openpgp` in your modules at stubs. Each stub loads the package, then
calls the real function; they share one `import()`, so the package is a chunk of its own, downloaded
once, by the first call. An action that awaits it waits for that download the first time, and its
element is busy (`aria-busy`, `$meta.<name>.loading` for a `<sn-resource call>`) meanwhile. Nothing in
the markup or the actions module changes.

## The one rule: every call is awaited

A stub returns a Promise, also for a function that is sync in the package. So a value imported from a
lazy package may only be called, and each call must be waited for:

```ts
const key = await openpgp.readKey({ armoredKey });              // awaited
return openpgp.encrypt({ message, encryptionKeys: keys });       // returned
openpgp.sign({ message }).then(show);                            // chained
void openpgp.verify({ message, verificationKeys });              // discarded on purpose
const [a, b] = await Promise.all([openpgp.readKey(x), openpgp.readKey(y)]);
const html = await marked.parse(md);                             // sync in the package: fine, awaited
```

What a call returns is the package's own object: `key.getFingerprint()` is an ordinary sync call.
Type-only uses (`import type`, annotations, `openpgp.PrivateKey` as a type) are erased and fine.

Anything else is `SN324` at its line, in the build, in dev and in `sinter check`, because it needs the
package loaded at once:

| Refused | Why, and what to do |
| --- | --- |
| `openpgp.encrypt(…)` with nothing waiting for it | a forgotten `await` would leave a Promise where TypeScript sees a value: await it |
| `new Chart(…)`, `x instanceof openpgp.PrivateKey` | classes need the package: use them in a [component script](#component-scripts), or `await import('chart.js')` where needed |
| `openpgp.enums.…`, `openpgp.config.x = …` | constants and settings, the same |
| `keys.map(openpgp.readKey)`, passing `openpgp` around | a function or the namespace as a value: call it where it is needed |
| `import 'openpgp'`, `export … from 'openpgp'` | side effects and re-exports need the package: import what you call where you call it |

**Helpers cannot use a lazy package.** They run synchronously while a binding renders, so they cannot
wait for a download: the helpers module reaching one through its imports is `SN324`, with the chain.
Compute the value in an action or a `<sn-resource call>`. If the first content of a page needs the
package (a markdown body rendered by a helper), do not make it lazy: loading it with the page is faster
there anyway.

A subpath is covered by its package: `lazy: ['openpgp']` covers `openpgp/lightweight`, which is a chunk
of its own. Your own heavy modules are not covered; a plain `import()` splits them, and the
[checks](#the-checks) and the [stale page](#a-stale-page) apply to those too.

## When it loads

By default, on first call. Two attributes, on any element of a page, a layout or a component, say
otherwise for the pages that need it sooner:

| When | Markup | What happens |
| --- | --- | --- |
| on first call | nothing | the first stub called loads the package |
| when an element is rendered | `data-sn-import="openpgp"` | the page module loads it when it renders the element: at takeover for an element outside templates, when its `data-sn-if` branch or row first renders otherwise. Never before takeover, so it does not compete with the page's own files |
| with the page | `data-sn-preload="openpgp"` | the build puts `<link rel="modulepreload">` for the package's chunks into the page's head: fetched and compiled in parallel with the page bundle, run on first call or by a `data-sn-import` |

```html
<!-- src/components/mail-reader.html: every page with a reader loads openpgp once it has taken over -->
<template data-sn-component="{ message: Message | null }">
  <div class="reader" data-sn-import="openpgp">…</div>
</template>
```

- The value is a list: `data-sn-import="openpgp, marked"`. A name that is not in `lazy` is `SN324`.
- The attributes take no expression. Put the element in a `data-sn-if` for a condition.
- `data-sn-preload` counts wherever it is in the page after components and the layout are expanded,
  inside templates too: it says the page may need the package. In a component, it applies to every page
  that uses the component; in a layout, to every page of the layout. A page that does not write its own
  head can still ask for it.
- A load `data-sn-import` starts that fails is silent; the call that needs the package reports it.
- On a slow network a big preload competes with the page bundle and the page's data: measure before
  preloading. The two attributes are apart for that reason. `vite dev` writes no preload links.

## Component scripts

A component built around a library's classes (`new Chart(…)`) cannot use stubs. So a component script
that imports a lazy package, directly or through your modules, becomes lazy too: the page module does not
import it; it is loaded, with the package, when the component first renders. Inside it, any use of the
package is fine.

```ts
// src/components/task-ring.ts, unchanged; `lazy: ['chart.js']` in the config
import Chart from 'chart.js/auto';
export class TaskRing extends TaskRingComponent {
  connected() { this.#chart = new Chart(this.refs.canvas, { … }); }
}
```

- The component's markup does not wait: it is expanded at build time and rendered as before. Only the
  script waits.
- `connected()` runs once the script and the package have arrived, with the props of that moment; the
  first `propsChanged()` comes after it. An instance removed before then never starts.
- Until then the script's effects are missing: what it draws, its `this.state` writes, its events.
  Write the markup so the component reads well without them.
- Each lazy script is a small chunk of its own; the package is one chunk they all share. Three
  components that use chart.js download it once, and a page with one of them does not download the
  others' scripts. The build lists the package's chunk as a dependency of the script's, so both
  downloads start together.
- `data-sn-preload="chart.js"` preloads the package and the page's component scripts that load with it.
- The build log names each lazy script and the import chain that made it lazy (`src/components/x.ts loads
  with chart.js, when its component first renders: src/components/x.ts → src/lib/chart.ts → chart.js`),
  so an innocent import that makes a component wait does not go unnoticed. A script that should run at
  once reaches the package only through `await import()`.
- Islands (custom elements your app defines and imports) are your modules: they get the stubs.

## The checks

The stubs make every import of the package in your code lazy, so your code cannot undo the split. Two
leaks remain, and the build fails on both with the chain (`SN325`):

```
SN325 mail.html: the page bundle contains openpgp, which `sinter({ lazy })` loads lazily:
  mail.html → src/lib/autocrypt.ts → node_modules/autocrypt/index.js → openpgp
```

- **Another package imports it.** Add that package to `lazy` too, or load it with `import()`. An early
  file that bundles a lazy package (the early module, or a helper an early binding calls, imports it) is
  `SN325` as well.
- **A module the page loads with `import()` is also imported statically by the page.** The split does
  nothing for that page (Vite warns about this; for pages, sinter makes it an error).

Each page's log line in the build shows what it defers next to what it ships:

```
sinter: mail.html: JavaScript 21.4 kB gzip + 8.2 kB gzip shared: …; lazy: openpgp 129.7 kB gzip
```

## A stale page

A tab that stayed open across a deploy asks for chunks the new deploy no longer has. sinter tells that
from other failures: when a lazy load fails, it requests the chunk's URL again.

| The server answers | `$error` |
| --- | --- |
| 404 or 410, or a 200 that is not JavaScript (a host serving `200.html` for every missing path) | `stale: true`, the message "this page is out of date: reload it" |
| nothing (the network failed) | `status: 0`, as for any request |
| JavaScript | the module threw: `status: null` with what it threw |

```html
<button data-sn-call="pgp.decrypt(msg)" data-sn-catch="error = $error.stale ? m.page_outdated() : $error.message">…</button>
<!-- or once for the page: the unhandled-error path carries the flag -->
<body data-sn-on-sn-error="$event.detail.error.stale && showModal('outdated')">
```

- Lazy packages, lazy component scripts, and an `import()` in an action function (when the browser names
  the module: Chromium and Firefox do, Safari does not, so there it stays the error the browser gave).
- sinter never reloads by itself: the page may hold a draft. A failed load is not cached; the next call
  tries again.
- Nothing old is kept on the server and no build id is needed: the URL is enough. Every navigation in a
  sinter app loads a page, so only a tab that stayed open is affected.
- `message` is English, as for sinter's other errors; show your own text from the flag.

## Testing

`render()` from `@tiaforge-ui/sinter/testing` accepts any name in `data-sn-import` and
`data-sn-preload` and loads nothing for them. Your functions import the package as they would anyway.
Under vitest with the app's Vite config the stubs apply, otherwise the real package does: both behave
the same, since every call is awaited.
