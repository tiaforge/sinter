# Proposal: pages without JavaScript

Status: draft, for discussion. Nothing here is implemented.

Since components arrived, a site can be built from layout components and plain pages that read no
data at all: a marketing site, docs, a blog. The compiler already writes build-time constants into
the HTML, so these pages are complete in the first frame. Today they still ship the runtime.

**The rule this proposes: a page ships JavaScript only if something on it has to run in the
browser.** It is not a mode or an option. It is what the build outputs once it can prove that
nothing on the page needs to run. A site that is static on some pages and an app on others gets
both: the runtime is a chunk that only the pages that need it load.

## What ships today

Measured on `main` (9168d84). Two pages share a `site-header` component with a constant `title`
prop and a scoped `<style>`. The pages have no state, no resources and no handlers:

```
dist/index.html
dist/about.html
dist/assets/app-*.css        120 B    the component's scoped style
dist/assets/app-*.js       33.7 kB    the runtime (14.1 kB gzip), shared: modulepreloaded by both pages
dist/assets/index-*.js       235 B    the page module: mounts one text binding
dist/assets/about-*.js       233 B
```

```js
// index-*.js: the page module mounts a binding whose value is a literal
await e(), t(document, { ir: { roots: [{ tag: 'h1', b: [{ k: 'text', f: 0 }], id: 0 }], … }, fns: [e => `My site`] });
```

Sizes are minified, before compression; over the wire the runtime is 14.1 kB gzip. It is one chunk
that every page shares, so a visitor downloads it once and later pages take it from the HTTP cache.
What every page load repeats is parsing and running it.

The HTML already says `<h1 data-sn="0">My site</h1>`. The binding can never change, but the browser
still downloads the runtime on the first visit, and parses and runs it on every page, to "keep it live".

A second probe shows the case that is worse than just wasted bytes:

```html
<!-- src/components/nav-list.html -->
<ul><template data-sn-for="i in items"><li><a data-sn-attr="{ href: i.href }" data-sn-text="i.label"></a></li></template></ul>

<!-- a page -->
<nav-list data-sn-prop="{ items: [{ href: '/', label: 'Home' }, { href: '/about.html', label: 'About' }] }"></nav-list>
```

The build outputs `<ul><template data-sn="1"><li><a></a></li></template></ul>`. A loop over a
constant list is **not rendered at build time**. The nav menu is empty in the first frame, and with
no JavaScript it stays empty. Static sites build their navigation, footers and feature grids
exactly like this, so this has to be fixed before dropping the runtime is even possible.

## Design

### 1. Constant bindings leave the page module

`prerender()` already writes each binding whose value is a build-time constant into the HTML, and
records it in `painted`. Those bindings stay in the IR, because the state they read might be
written later.

New: a painted binding that **reads nothing** is dropped from the IR. "Reads nothing" means its
`d` (dependencies) is empty: literals, a constant prop, a `data-sn-if` that was already folded. Its
`data-sn` marker goes too, and so does a node that has no bindings left. This alone makes the
`site-header` page's IR empty.

That is safe because a binding with no dependencies is never re-run by the runtime anyway. Today it
runs once at mount and writes the same value the HTML already has.

### 2. Loops over constants are unrolled at build time

When the list of a `data-sn-for` is a build-time constant (same evaluator as `prerender()`: literals,
constant props, no helpers, no `$url`/`$now`/`$locale`), the compiler expands the template once per
item. Each row's bindings are evaluated with the item in scope, as in (1). Rows whose bindings all
read only the item and constants are plain markup: no template and no IR entry.

A loop that is constant but whose rows contain something live (a handler, a nested resource read)
still needs the runtime. Either it stays a template as today, or (better, and also good for first
paint on app pages) it is rendered at build time and adopted by the runtime the way it adopts rows
rendered from embedded data. Proposed: unroll fully-static loops in this step and treat the second
kind as a follow-up.

The early script and the page module benefit too: a constant list on an app page stops costing a
template, a `find`/`make` pair and a render.

### 3. (Later) State that nothing writes is a constant

`<main data-sn-state="{ year: 2026 }"><p data-sn-text="'© ' + year">` is painted today, but stays
live because `year` could be written. If no handler, model, action `then`, component script or
`persist` on the page writes a field, that field is a constant and (1) applies to it. The compiler
already knows every write (`w` on bindings, `data-sn-model` paths, `persisted`). Component scripts
write `this.state` opaquely, so a component with a script keeps all of its state live.

This is less common on purely static sites than (1) and (2), so it can come second.

### 4. The plugin outputs no script for a page with nothing to run

After (1) to (3), the compiler decides that **a page needs no runtime** when all of these hold:

| Needs the runtime | Detected from |
| --- | --- |
| a binding left in the IR (reads state, a resource, `$url`, `$now`, `$locale`, a helper, a formatter) | `ir.roots`, `ir.templates` |
| a resource, a stream (`<sn-sync>`), an action, a handler (`data-sn-on-*`, `data-sn-call`) | `ir.resources`, `syncs`, `actions` |
| a `data-sn-model`, `data-sn-persist`, `data-sn-listbox`, key shortcuts | the bindings / `features` |
| a component with a script (`src/components/<name>.ts`) | the expansion |
| messages that switch language in the browser (`m.*` with a language picker) | `namespaces` |
| a pending morph (`data-sn-transition`) | `holdPages` |
| images from the API through the resizing service | `parts.remote` |
| embedded data (`embed: true`) | `out.embed` |

If none hold, `CompileResult.module` is `null` and:

- `injectScript` adds no `<script type="module">` and no early script;
- the post plugin adds no shared head script, no modulepreload of the runtime chunk, and no hold script;
- `data-sn` markers are stripped (`data-sn-c` / `data-sn-s` stay: scoped CSS selects them);
- Speculation Rules stay. They are a `<script type="speculationrules">` with JSON in it, not
  JavaScript, and they keep next-page HTML prefetch / prerender in Chromium;
- the page's CSS still loads. Component styles reach Vite today as an import of the page module.
  The page gets a `<link rel="stylesheet">` to the component CSS module instead, which Vite's HTML
  pipeline bundles like any linked stylesheet. Fallback if that does not survive Vite's HTML
  handling: keep a CSS-only entry and delete its empty JS chunk and tag in `generateBundle`.

If every page is static, `dist/` contains no `.js` file at all.

### 5. Seeing why a page ships JavaScript

The build already reports one line per page for the early script. It gets one more fact:

```
sinter: index.html: no JavaScript
sinter: contact.html: runtime 14.1 kB gzip (shared), page 0.4 kB: data-sn-on-submit (contact.html:12), resource `countries`
```

The reasons list the first few things from the table in (4), with locations.

And an assertion for pages that must stay static, so that adding `data-sn-on-click` to the footer
does not quietly put 14 kB back on every page of a docs site:

```html
<html data-sn-static>
```

A page with `data-sn-static` that needs the runtime fails the build with a new diagnostic (`SN318`):
"about.html must ship no JavaScript (`data-sn-static`), but `data-sn-on-click` in
src/components/site-footer.html:4 runs in the browser". It is checked in `sinter check` and the
LSP too, through the component that caused it.

## What changes on a page that ships no JavaScript

These are the behaviours a static page loses. They are the decisions to make before implementing.

- **The app's config module (`src/sinter.config.ts`) and early module (`src/sinter.early.ts`) do
  not run.** They configure sinter (error handling, request middleware), and sinter does not run
  on the page. An app that needs a script on every page (analytics, say) adds its own
  `<script type="module" src>`, which Vite bundles as usual and which does not pull in the runtime.
- **Next-page data is not prefetched from that page.** Hovering a link from a static page to a page
  with data no longer requests that page's data. Speculation Rules still prefetch the HTML, and
  `speculation: 'prerender'` loads the data too in Chromium. Elsewhere, the data page loads its data
  after one round trip, as on a first visit. (Alternative: a small standalone prefetch script on
  static pages that link to data pages. Its size is not measured yet; it imports the store and URL
  helpers, not the runtime.)
- **Dev matches the build.** The dev server also omits the page module on such a page, so a
  developer sees the same page. Vite's own client is still injected in dev, as it is for any page.

## Testing

- Build tests (`test/vite/`): a two-page static site outputs no `<script type="module">`, no
  modulepreload and no `.js` file; the CSS is linked and scoped styles apply. A mixed site: the
  static page has no script and the data page is unchanged.
- Compiler tests: a constant binding is not in the IR and has no `data-sn`; a constant loop is
  expanded with its bindings evaluated per row; a loop over state is untouched; `data-sn-static`
  with a handler in a nested component fails with `SN318` at the component's line.
- Browser (Chromium, Firefox, WebKit): each static fixture renders the same with JavaScript
  disabled (`javaScriptEnabled: false`) as with it.
- RealWorld: no page should change (they all read data). The page module sizes there show what
  (1) and (2) save on app pages.

## Plan

1. Drop zero-dependency painted bindings from the IR and their markers (1).
2. Unroll `data-sn-for` over constants (2). This also fixes the empty first frame for constant lists
   on app pages, so it is worth doing even without the rest.
3. `module: null` and the plugin changes, including the CSS path (4).
4. The build report line and `data-sn-static` / `SN318` (5).
5. Read-only state as constants (3).
6. Docs: a "Static pages" section in `first-paint.md` or its own guide, the README line "a small
   runtime ships with each page" becomes "with each page that needs one", and a CHANGELOG entry.

## Open questions

1. **Prefetch from static pages**: drop it (proposed), or ship a small prefetch-only script when a
   static page links to a page with data?
2. **Config module**: skip it on static pages (proposed), or treat "the app has a config module" as a
   reason to ship the runtime? Skipping is what makes static pages possible in an app that has one,
   which is most apps made with the starter template.
3. **Opt-in vs. automatic**: automatic with an optional `data-sn-static` assertion (proposed), or
   only for pages that ask with `data-sn-static`? Automatic changes the output of existing pages
   that happen to need nothing, but the only observable difference is the two points above.
4. **Site-wide assertion**: is the per-page `data-sn-static` enough, or should there be a
   `sinter({ static: ['docs/**'] })` option for a whole section?
5. **i18n**: a static page with messages still needs the picker to switch language in the browser.
   Building one HTML file per locale would make such sites static too. In scope here, or a separate
   proposal?
