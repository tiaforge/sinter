# Proposal: pages without JavaScript

Status: draft, every question settled (see [Decisions](#decisions)). Nothing here is implemented. It builds on
[layouts](../layouts.md) and on constants left out of the page module, both merged in
[#26](https://github.com/tiaforge/sinter/pull/26). Every measurement below is from `main` at 5e6c1c8.

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

My first draft of this proposal (against `main` before #26) had five steps. Two of them shipped in #26:

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
- Scripts the layout or the page writes (`<script type="module" src="./main.ts">` in the
  [layouts guide](../layouts.md)) stay: they are the app's, and Vite bundles them as usual without the runtime.
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
does not quietly put the runtime back on every page of a docs site. It is a matcher in the plugin's
options, over page paths relative to the root:

```js
sinter({ static: ['index.html', 'about.html', 'docs/**'] })
sinter({ static: true })                                     // every page
```

A matched page that needs the runtime fails the build with a new diagnostic (`SN322`, after #26's
`SN318`–`SN321`): "about.html must ship no JavaScript (`sinter({ static })`), but `data-sn-on-click`
in src/components/site-footer.html:4 runs in the browser". It is checked in `sinter check` and the
LSP too, at the element that caused it, in the page, component or layout. A pattern that matches no
page is a build error too, so that renaming a page does not silently drop it from the check.

The matcher is the only place for it. A page attribute would be a second way to say the same thing,
and with layouts it would have to be repeated on every page tag; on the layout it would make every
page that uses the layout static, which is not what a layout is about. A single page is a matcher
with one entry.

### 4. Multilingual static sites: one HTML file per language

Today a page with messages has one HTML file. The base language's text is in it; a script in the
head picks the visitor's language before the first paint (the stored choice, else
`navigator.languages`, else the base), loads that language's file for the page, and the runtime
renders the messages. For another language the message elements stay hidden until it has, up to 3 s.
Switching is `$locale = 'de'`, without a reload.

That needs the runtime. The layout site above, with the title and one paragraph from messages
(`en`, `de`):

```
dist/assets/messages-*.js     35.1 kB   the runtime with the messages module (14.7 kB gzip)
dist/assets/sinter-head-*.js   5.2 kB   the language picker and the early runtime (2.4 kB gzip)
dist/assets/about-head-*.js    1.4 kB   the page's early bindings (0.8 kB gzip)
dist/assets/about-en-*.js, about-de-*.js   the page's messages, one file per language
```

And the HTML is not complete in any language: `<meta name="description">` gets its content from a
message, and messages are written into the HTML only as text, so the description is empty until the
runtime fills it. A crawler sees English text with no description, and never sees the German page.

**Proposed: the language is part of the URL, and each page is built once per language.**

```js
sinter({ localePrefix: true })
```

```
dist/en/about.html     <html lang="en">, English in the HTML
dist/de/about.html     <html lang="de">, German in the HTML
dist/index.html        the root: sends the visitor to the base language (below)
```

Every language is prefixed, the base too. Every page URL then has one shape, `/{locale}/{path}`, which
is what makes routing on a server simple:

- A server or host routes on the first segment alone: `/de/*` is German, with no list of which paths
  are pages of the base language. Nothing can collide, such as a base-language page or folder named
  `de`.
- Changing the base language, or adding one, changes no existing URL.
- `data-sn-path` patterns are written without the prefix (`/article/:slug`) and match under each
  language (`/de/article/:slug`); `$url` does not include it. sinter-axum's manifest lists the
  languages, and its router mounts each page under every prefix.
- The root has no language of its own. The build writes a `dist/index.html` that sends the visitor
  to the base language without JavaScript (`<meta http-equiv="refresh" content="0; url=/en/">`, a link to
  each language, and the `hreflang` links). A host that redirects on `Accept-Language` takes over
  before it.

**Links stay in their language.** A link to one of the app's pages is written with the page's path, as
today (`<a href="/about.html">`), and each language's file links to that language: the German build
writes `/de/about.html`. So a visitor who is on a German page stays on German pages, with nothing
stored. The build rewrites:

- every root-relative `href` that matches one of the app's pages (the same match Speculation Rules
  use), in markup and in bindings the build evaluates (constants, `data-sn-attr` over props);
- relative links need nothing: `about.html` from `/de/index.html` stays under `/de/`;
- `href`s bound at run time on app pages (from data) get the prefix from the runtime, by the same
  match;
- a link with `hreflang` points to a language on purpose (a language switcher) and is left as it is.

- Each file is compiled with the locale fixed. `$locale` is a build-time constant, and every message
  call over constants is written into the HTML in that language, in text and in attributes
  (`<title>`, `<meta content>`, `aria-label`). After that the page is static by the same rule as any
  other: nothing in the table of step 2 is left, so it ships no JavaScript.
- `date()` and `number()` over constants are formatted at build time with Node's `Intl` in that
  locale. (Node and the browser may use different ICU versions; this is text written once, as a
  server would.)
- Switching language is a link. A built-in `localeUrl('de')` is the URL of this page in German; it is a
  constant in each file, so a language switcher is plain markup (the `hreflang` keeps its link out of
  the rewrite above):

  ```html
  <a data-sn-attr="{ href: localeUrl('de'), 'aria-current': $locale === 'de' ? 'true' : null }" hreflang="de">Deutsch</a>
  ```
- Each head gets `<link rel="alternate" hreflang="…">` for every language and `x-default` for the
  base, so search engines index and link each language.
- It is a choice for the whole site, and it applies to every page, not only static ones. Without
  `localePrefix` nothing changes: one HTML file per page, the language picked in the browser and
  `$locale = 'de'` switching in place, keeping the page's state. The two models do not mix in one
  site: switching in place on `/de/inbox.html` would show English at a German URL. With it, an app
  page gets its text in
  the first frame in every language, with nothing hidden, and needs no picker. Messages over data
  (`m.inbox_count({ count: inbox.unread })`) still render in the browser, from that language's file,
  which the page module imports directly. `$locale` cannot be assigned (a build error): switching is
  navigation.
- Everything else that knows page paths learns the prefix: Speculation Rules, next-page data and
  embedded data's page paths.
- A missing translation falls back to the base language, as today.

What it does not do:

- **Choose the language on the first visit, or remember it.** Without JavaScript, a visitor who opens
  `/` gets the base language and a switcher; from then on the links keep them in the language they
  are in. Nothing is stored: a visitor who comes back to `/` gets the base language again. Visitors from a search engine land on their language's URL
  through `hreflang`. A host that can redirect on `Accept-Language` can do it there; the guide shows
  how for common static hosts, without sinter shipping anything.
- **Translate paths** (`/de/ueber-uns`) or let a language have different markup. Messages only.

The risk to try first: Vite builds the HTML files it is given as inputs, and `de/about.html` is not a
file. The plugin would add one virtual input per page and language whose content is the source page,
and compile it with the locale taken from its path; the dev server serves `/de/…` the same way.

## What changes on a page that ships no JavaScript

These are the behaviours a static page loses.

- **The app's config module (`src/sinter.config.ts`) does not run.** This is a rule, not an open
  question: everything `configure()` sets only matters while the runtime runs. `request` middleware,
  `sessionProbe`, `origins` and `retry` apply to requests. `onError` and `fieldErrors` apply to failed
  loads and actions. `locale`, `transport`, `confirm` and `urlSchemes` apply to `$locale` and the
  formatters, streams, `data-sn-confirm` and bound `href`/`src`. A page with nothing to run has
  none of these.

  The one thing that changes is the module's other top-level code. Every page module imports it
  today, so whatever else it does (an analytics or error-tracking snippet) runs on every page, and
  would stop running on static pages. The docs say so: the config module configures sinter and runs
  on the pages that run sinter; code for every page goes in a script the layout includes, as the
  [layouts guide](../layouts.md) does with `./main.ts`. `configuration.md` gets the same sentence.
- **The early module (`src/sinter.early.ts`) is already like this.** It runs from the shared head
  script, which the build adds only to pages with early bindings or languages; a page with nothing
  early does not run it today.
- **Next-page data is not prefetched from that page.** Two features prefetch the next page, and only
  one of them is JavaScript:
  - *Speculation Rules* are written at build time (a `<script type="speculationrules">` with JSON, or
    a response header) and run nothing: the browser prefetches the next page's HTML, or prerenders the
    whole page with `speculation: 'prerender'`. Chromium only. Static pages keep them unchanged.
  - *Next-page data* (`src/prefetch.ts`, in the page bundle) is the runtime's. When the pointer rests on
    a link (65 ms), it has focus, or a press or touch starts on it, it matches the link to one of the
    app's pages, works out that page's resource URLs from the link's `$url`, requests them through the
    app's request layer (the middleware of `sinter.config.ts`, so auth headers apply) and keeps the
    responses in sessionStorage for 30 s. The next page's runtime shows them at once and revalidates.
    Every browser. Markup cannot do this: Speculation Rules fetch documents, not data, and
    `<link rel="prefetch">` only fills the HTTP cache, which API responses often bypass (`no-store`,
    auth headers); the hand-off also needs the runtime on both pages.

  A static page loses only the second, and less than it sounds:
  - A site that is static throughout loses nothing: the build only adds next-page data when some
    page has resources to prefetch.
  - It matters only for links from a static page to a data page (a marketing page linking into the
    app).
  - In Chromium, `speculation: 'prerender'` loads that page's data before the click.

  What remains is Firefox and Safari: a data page opened from a static page shows its data one round
  trip after it opens, as on a first visit, instead of at once. Decided: static pages do without it,
  and the static pages guide says so, with `speculation: 'prerender'` as the way to get the data
  there before the click in Chromium.
- **Dev matches the build.** The dev server also omits the page module on such a page, so a
  developer sees the same page. Vite's own client is still injected in dev, as it is for any page.

## Testing

- Build tests (`test/vite/`): the layout site above outputs no `<script type="module">`, no
  modulepreload and no `.js` file; the CSS is linked and scoped styles apply. With a `main.ts` in the
  layout, that script is the only one. A mixed site: the static page has no script, and the data
  page is unchanged.
- Compiler tests: a constant loop is expanded with its bindings evaluated per row, in a component
  and through a layout prop; a loop over written state is untouched; a state with no fields left has
  no node; a page matched by `sinter({ static })` with a handler in a nested component or the layout
  fails with `SN322` at that element; a pattern that matches no page fails the build.
- Locale URLs: each page is built once per language with the text, attributes and head in that
  language, `lang`, `hreflang` links and `localeUrl()` written in; links to the app's pages carry the
  page's language (root-relative ones rewritten, bound ones from the runtime, `hreflang` links left);
  the root `index.html` sends a visitor without JavaScript to the base language; a static page ships no JavaScript in
  any language; an app page imports only its language's file and has no picker; assigning `$locale`
  is a build error; `data-sn-path`, Speculation Rules and next-page data carry the prefix. In the dev
  server, `/de/…` serves the German page.
- Browser (Chromium, Firefox, WebKit): each static fixture renders the same with JavaScript
  disabled (`javaScriptEnabled: false`) as with it.
- RealWorld: no page should stop shipping JavaScript (they all read data). The page module sizes
  there show what step 1 saves on app pages.

## Plan

1. Unroll `data-sn-for` over constants (step 1). This also fixes the empty first frame for constant
   lists on app pages, so it is worth doing even without the rest.
2. Clean up #26's leftovers: no `fns` placeholders, no node for an empty state (step 2).
3. `module: null` and the plugin changes, including the CSS path (step 2).
4. The build report line, and `sinter({ static })` / `SN322` (step 3).
5. A prototype of the virtual per-language inputs in Vite, build and dev, before the rest of step 4.
6. Locale URLs (step 4): fixed-locale compilation, messages in attributes, build-time `date()` and
   `number()`, `localeUrl()`, `hreflang`, link rewriting, the root `index.html`, the prefix in
   everything that knows page paths, sinter-axum's router.
7. Docs: a guide, `docs/static-pages.md` (what ships no JavaScript and why, the report line, the
   matcher, next-page data, the config module, multilingual sites and first-visit redirects on common
   hosts), linked from `layouts.md` and `first-paint.md`; the config module's rule in
   `configuration.md`; locale URLs in the messages section; the README line "a small runtime ships with each page" becomes "with each page
   that needs one", and a CHANGELOG entry.

## Open questions

None left. Worth watching once it is used: locale URLs may turn out to be the better model for
apps in general, not only an optimization for static sites. If they do, making them the only model
is a separate, breaking change.

## Decisions

Settled in review, in the order they were discussed:

| Question | Decision | Section |
| --- | --- | --- |
| The config module on static pages | It does not run: everything `configure()` sets applies only while the runtime runs. The docs say code for every page goes in a script the layout includes | [What changes](#what-changes-on-a-page-that-ships-no-javascript) |
| Automatic or opt-in | Automatic: every page with nothing to run ships no JavaScript, with no option to ask for it. `sinter({ static })` is an optional assertion that fails the build (`SN322`) when a matched page would need the runtime | [Seeing why a page ships JavaScript](#3-seeing-why-a-page-ships-javascript) |
| Next-page data on static pages | Dropped; the static pages guide says so and points to `speculation: 'prerender'` | [What changes](#what-changes-on-a-page-that-ships-no-javascript) |
| Where the assertion goes | Only in the plugin's options, `sinter({ static: [...] \| true })`: no page attribute, nothing on layouts | [Seeing why a page ships JavaScript](#3-seeing-why-a-page-ships-javascript) |
| Multilingual static sites | In scope: one HTML file per page and language | [Multilingual static sites](#4-multilingual-static-sites-one-html-file-per-language) |
| Locale URLs | Every language prefixed, the base too (`/en/…`, `/de/…`): one URL shape for servers; the root sends visitors to the base language | [Multilingual static sites](#4-multilingual-static-sites-one-html-file-per-language) |
| Staying in a language | Nothing is stored; each language's files link to that language's pages, so a visitor stays in the language they are in | [Multilingual static sites](#4-multilingual-static-sites-one-html-file-per-language) |
| The option's name | `sinter({ localePrefix: true })`: it says what the build does | [Multilingual static sites](#4-multilingual-static-sites-one-html-file-per-language) |
| One model or two | Both, chosen per site: the in-browser switch stays the default, `localePrefix` makes the whole site use locale URLs. Revisit once locale URLs have been used | [Multilingual static sites](#4-multilingual-static-sites-one-html-file-per-language) |
