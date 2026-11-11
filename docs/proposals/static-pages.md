# Proposal: pages without JavaScript

Status: draft, for discussion. Nothing here is implemented. It builds on
[#26](https://github.com/tiaforge/sinter/pull/26) (layouts, and constants left out of the page
module), and every measurement below is from that branch (bff91c5).

With layouts, a site can be one layout and plain pages that read no data at all: a marketing site,
docs, a blog. The compiler writes build-time constants into the HTML, and since #26 the page module
carries nothing for them. So these pages are complete in the HTML, and the page module mounts an
empty IR. They still ship the runtime to do that.

**The rule this proposes: a page ships JavaScript only if something on it has to run in the
browser.** It is not a mode or an option. It is what the build outputs once it can prove that
nothing on the page needs to run. A site that is static on some pages and an app on others gets
both: the runtime is a chunk that only the pages that need it load.

## What ships today

A layout with a head component (`<title>` and a description from a `title` prop), a nav whose
active link is a `data-sn-class` over a `nav` prop, and a footer slot with fallback content. Two
pages, each only the layout's tag with constant props:

```html
<!-- about.html -->
<site-layout data-sn-prop="{ title: 'About', nav: 'about' }"><p>About us.</p></site-layout>
```

The HTML is complete: `<title>About</title>`, `<meta name="description" content="About – my site">`,
`<a href="/about.html" class="active">`, no `data-sn` marker left. And each page still gets:

```
<script type="module" crossorigin src="/assets/about-*.js" async></script>
<link rel="modulepreload" crossorigin href="/assets/app-*.js">

dist/assets/app-*.js      33.7 kB    the runtime (14.1 kB gzip), shared by both pages
dist/assets/about-*.js      190 B    the page module
dist/assets/index-*.js      190 B
```

```js
// about-*.js: mounts nothing
await e(), t(document, { ir: { v: 2, resources: [], roots: [], templates: [], actions: [], ps: { … } }, fns: [0, 0, 0, 0], features: [] });
```

Sizes are minified, before compression; over the wire the runtime is 14.1 kB gzip. It is one chunk
that every page shares, so a visitor downloads it once and later pages take it from the HTTP cache.
What every page load repeats is parsing and running it, here to mount an empty IR.

## What #26 already does

My first draft of this proposal (against `main`) had five steps. Two of them shipped in #26:

| First draft | In #26 |
| --- | --- |
| A binding that reads nothing leaves the IR, with its `data-sn` marker | Done: "a value that can never change is written into the HTML and carries nothing in the page module", at the top level and inside templates |
| State that nothing writes is a constant | Done, and more: dependencies on such state are left out of every binding, unread fields leave their state, and a `data-sn-if` over it is decided at build time |

That leaves three steps, plus two small leftovers of #26 that matter here because they keep an
otherwise empty page module non-empty.

## Design

### 1. Loops over constants are unrolled at build time

Not covered by #26. A component that loops over a constant prop:

```html
<!-- src/components/nav-list.html -->
<ul><template data-sn-for="i in items"><li><a data-sn-attr="{ href: i.href }" data-sn-text="i.label"></a></li></template></ul>

<!-- a page -->
<nav-list data-sn-prop="{ items: [{ href: '/', label: 'Home' }, { href: '/about.html', label: 'About' }] }"></nav-list>
```

outputs `<ul><template data-sn="1"><li><a></a></li></template></ul>`, and the page module carries
the list, the template and its `find`/`make` functions. The nav is empty in the first frame, and with
no JavaScript it stays empty. Static sites build navigation, footers and feature grids this way, so
this blocks step 2 for them, and it is a first-frame gap on app pages too.

When the list is a build-time constant (the evaluator #26 uses: literals, constant props, state
nothing writes; no helpers, `$url`, `$now`, `$locale`), the compiler expands the template once per
item and evaluates each row's bindings with the item in scope. Rows whose bindings read only the item
and constants become plain markup, with no template and nothing in the IR.

A constant loop whose rows contain something live (a handler, a resource read) still needs the
runtime. Proposed: it stays a template as today, and rendering it at build time for the runtime to
adopt (as it adopts rows rendered from embedded data) is a follow-up.

### 2. The plugin outputs no script for a page with nothing to run

A page **needs no runtime** when none of these hold:

| Needs the runtime | Detected from |
| --- | --- |
| a binding left in the IR (reads written state, a resource, `$url`, `$now`, `$locale`, a helper, a formatter) | `ir.roots`, `ir.templates` |
| a resource, a stream (`<sn-sync>`), an action, a handler (`data-sn-on-*`, `data-sn-call`), including handlers on the layout tag | `ir.resources`, `syncs`, `actions` |
| a `data-sn-model`, `data-sn-persist`, `data-sn-listbox`, key shortcuts | the bindings, `features` |
| a component with a script (`src/components/<name>.ts`) | the expansion |
| messages that switch language in the browser (`m.*` with a language picker) | `namespaces` |
| a pending morph (`data-sn-transition`) | `holdPages` |
| images from the API through the resizing service | `parts.remote` |
| embedded data (`embed: true`) | `out.embed` |

If none hold, `CompileResult.module` is `null`, and:

- `injectScript` adds no `<script type="module">` and no early script.
- The post plugin adds no shared head script, no modulepreload of the runtime chunk and no hold script.
- Scripts the layout or the page writes (`<script type="module" src="./main.ts">` in the layouts
  guide) stay: they are the app's, and Vite bundles them as usual without the runtime.
- Speculation Rules stay. They are a `<script type="speculationrules">` with JSON in it, not
  JavaScript, and they keep next-page HTML prefetch and prerender in Chromium.
- The page's CSS still loads. Component styles reach Vite today as an import of the page module.
  Instead the page gets a `<link rel="stylesheet">` to the component CSS module, which Vite's HTML
  pipeline bundles like any linked stylesheet. If that does not survive Vite's HTML handling, the
  fallback is to keep a CSS-only entry and delete its empty JS chunk and tag in `generateBundle`.

If every page is static and the layout has no script of its own, `dist/` contains no `.js` file.

The two leftovers of #26 to clean up on the way, so that "nothing to run" is an empty IR:

- `fns: [0, 0, 0, 0]`: slots of the dropped functions stay in the table as placeholders. On a page
  that keeps its module they cost a few bytes; here they are only noise to test against.
- A `data-sn-state` whose fields all left (`{ year: 2026 }` read only by a constant binding) keeps
  its element in the IR with a state of `() => ({})`, and its `data-sn` marker. A state with no
  fields left should leave, with its node.

### 3. Seeing why a page ships JavaScript

The build already reports one line per page for the early script. It gets one more fact:

```
sinter: index.html: no JavaScript
sinter: contact.html: runtime 14.1 kB gzip (shared), page 0.4 kB: data-sn-on-submit (contact.html:12), resource `countries`
```

The reasons list the first few things from the table in step 2, with locations, including the
component or layout file they are in.

And an assertion for pages that must stay static, so that adding `data-sn-on-click` to the footer
does not quietly put the runtime back on every page of a docs site. On a page written by hand it
goes on `<html>`. On a layout page, the tag's plain attributes go onto `<html>`, so it goes on the
tag, or on the layout's `<html>` for every page that uses it:

```html
<site-layout data-sn-static data-sn-prop="{ title: 'About', nav: 'about' }">…</site-layout>
```

A page with `data-sn-static` that needs the runtime fails the build with a new diagnostic (`SN322`,
after #26's `SN318`–`SN321`): "about.html must ship no JavaScript (`data-sn-static`), but
`data-sn-on-click` in src/components/site-footer.html:4 runs in the browser". It is checked in
`sinter check` and the LSP too, through the component or layout that caused it.

## What changes on a page that ships no JavaScript

These are the behaviours a static page loses. They are the decisions to make before implementing.

- **The app's config module (`src/sinter.config.ts`) and early module (`src/sinter.early.ts`) do
  not run.** They configure sinter (error handling, request middleware), and sinter does not run
  on the page. An app that needs a script on every page (analytics, say) puts it in the layout, as
  the layouts guide does with `./main.ts`.
- **Next-page data is not prefetched from that page.** Hovering a link from a static page to a page
  with data no longer requests that page's data. Speculation Rules still prefetch the HTML, and
  `speculation: 'prerender'` loads the data too in Chromium. Elsewhere, the data page loads its data
  after one round trip, as on a first visit. The alternative is a small standalone prefetch script on
  static pages that link to data pages. Its size is not measured yet; it imports the store and URL
  helpers, not the runtime.
- **Dev matches the build.** The dev server also omits the page module on such a page, so a
  developer sees the same page. Vite's own client is still injected in dev, as it is for any page.

## Testing

- Build tests (`test/vite/`): the layout site above outputs no `<script type="module">`, no
  modulepreload and no `.js` file; the CSS is linked and scoped styles apply. With a `main.ts` in the
  layout, that script is the only one. A mixed site: the static page has no script, and the data
  page is unchanged.
- Compiler tests: a constant loop is expanded with its bindings evaluated per row, in a component
  and through a layout prop; a loop over written state is untouched; a state with no fields left has
  no node; `data-sn-static` with a handler in a nested component fails with `SN322` at the
  component's line, and on the layout tag and the layout's `<html>`.
- Browser (Chromium, Firefox, WebKit): each static fixture renders the same with JavaScript
  disabled (`javaScriptEnabled: false`) as with it.
- RealWorld: no page should stop shipping JavaScript (they all read data). The page module sizes
  there show what step 1 saves on app pages.

## Plan

1. Unroll `data-sn-for` over constants (step 1). This also fixes the empty first frame for constant
   lists on app pages, so it is worth doing even without the rest.
2. Clean up #26's leftovers: no `fns` placeholders, no node for an empty state (step 2).
3. `module: null` and the plugin changes, including the CSS path (step 2).
4. The build report line, and `data-sn-static` / `SN322` (step 3).
5. Docs: a "Static pages" section in `layouts.md` (where static sites start) linked from
   `first-paint.md`, the README line "a small runtime ships with each page" becomes "with each page
   that needs one", and a CHANGELOG entry.

## Open questions

1. **Prefetch from static pages**: drop it (proposed), or ship a small prefetch-only script when a
   static page links to a page with data?
2. **Config module**: skip it on static pages (proposed), or treat "the app has a config module" as a
   reason to ship the runtime? Skipping is what makes static pages possible in an app that has one,
   which is most apps made with the starter template.
3. **Opt-in vs. automatic**: automatic with an optional `data-sn-static` assertion (proposed), or
   only for pages that ask with `data-sn-static`? Automatic changes the output of existing pages
   that happen to need nothing, but the only observable difference is the two points above.
4. **Where the assertion goes**: on the page (or layout tag), on the layout's `<html>` for all its
   pages, or also a `sinter({ static: ['docs/**'] })` option for a whole section?
5. **i18n**: a static page with messages still needs the picker to switch language in the browser.
   Building one HTML file per locale would make such sites static too. In scope here, or a separate
   proposal?
