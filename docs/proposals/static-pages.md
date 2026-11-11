# Proposal: pages without JavaScript

Status: draft, for discussion (see [Open questions](#open-questions) and [Decisions](#decisions)). Nothing here is implemented. It builds on
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
dist/about.html        a redirect to the visitor's language (below)
dist/index.html        the same for the root
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
- No page is written at its own path in a language: the source `about.html` is `/en/about.html` and
  `/de/about.html`, and the source `index.html` is `/en/` and `/de/`. At the unprefixed path
  (`/about.html`, and `/` for the root) the build writes a redirect file instead, described under
  "Remembering the language" below.
- Paths in sinter's own options are source paths, without the prefix: `sinter({ static: ['about.html'] })`
  matches `about.html` in every language.

**Links stay in their language.** A link to one of the app's pages is written with the page's source
path, as today (`<a href="/about.html">`), and each language's file links to that language: the
English build writes `/en/about.html`, the German one `/de/about.html`. So a visitor who is on a German
page stays on German pages, with nothing stored. The build rewrites:

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
- Each head gets `<link rel="alternate" hreflang="…">` for every language's URL of the page, and
  `x-default` for the root (`/`), which sends a visitor to a language, so search engines index and
  link each language. Search engines want these URLs absolute, so they are written from
  `sinter({ site })` (step 5); without it the build writes none and says so once.
- It is a choice for the whole site, and it applies to every page, not only static ones. Without
  `localePrefix` nothing changes: one HTML file per page, the language picked in the browser and
  `$locale = 'de'` switching in place, keeping the page's state. The two models do not mix in one
  site: switching in place on `/de/inbox.html` would show English at a German URL. With it, an app
  page gets its text in the first frame in every language, with nothing hidden, and needs no picker. Messages over data
  (`m.inbox_count({ count: inbox.unread })`) still render in the browser, from that language's file,
  which the page module imports directly. `$locale` cannot be assigned (a build error): switching is
  navigation.
- Everything else that knows page paths learns the prefix: Speculation Rules, next-page data and
  embedded data's page paths.
- A missing translation falls back to the base language, as today.

**Remembering the language.** Links keep a visitor in their language while they follow them. An
unprefixed URL (`/`, `/about.html`: typed, bookmarked, or linked from another site) is where the
language has to be chosen again, and the redirect file at that path does it:

- **Without JavaScript**, it sends the visitor to the base language: `<meta http-equiv="refresh"
  content="0; url=/en/about.html">`, a link to each language, `<meta name="robots" content="noindex">`,
  and the `hreflang` links. This is all a site gets when no page of it ships JavaScript: nothing on
  it can record a choice, and the site stays without a single `.js` file. A host that redirects on
  `Accept-Language` can choose the first visit's language before the file is served.
- **On a site where pages ship JavaScript**, those pages record the language they are in, on every
  visit: a cookie, `locale=de; Path=/; Max-Age=31536000; SameSite=Lax`, written by the page module.
  The redirect files then carry a small inline script that runs before the refresh: the cookie's
  language if it is one of the site's, else the first match in `navigator.languages`, else the base,
  and `location.replace()` to that language's URL of the same path. A visitor who was last on a German
  page and opens `/about.html` lands on `/de/about.html`.
- A cookie rather than `localStorage`, so that a server can redirect on it too, without serving the
  file: sinter-axum's router redirects unprefixed paths by the cookie, else `Accept-Language`, and a
  static host with cookie conditions in its redirect rules can do the same. The guide shows both.
- The script is inline, in a file that is only ever a redirect, so it costs no request. With a CSP in a
  `<meta>` the build adds its hash, as it does for Speculation Rules; for a CSP sent as a header, the
  build prints the hash.
- The language recorded is the last one of a page that ran JavaScript. On a site with both kinds of
  page, a visitor who switched to German on a static page and then opens `/about.html` gets the
  language of the last page that recorded one. The guide says so.

What it does not do:

- **Translate paths** (`/de/ueber-uns`) or let a language have different markup. Messages only.

The risk to try first: Vite builds the HTML files it is given as inputs, and neither `en/about.html`
nor `de/about.html` is a file. The plugin would replace each page's input with one virtual input per
language whose content is the source page, compile it with the locale taken from its path, and write
the redirect file at the unprefixed path. The dev server does the same: it serves `/{locale}/…` and
the redirect files as the build writes them.

### 5. Canonical URLs

A static page has no way to state its canonical URL today, other than writing it by hand:

- `<link rel="canonical" href="https://example.com/about.html">` written literally works, on a page
  written by hand or through a layout's head slot (`<link slot="head" rel="canonical" href="…">`), one
  per page, kept in sync with the file's name by hand.
- A layout cannot write it for its pages: bindings on `<link>` are `SN207`, since a value from data
  could load a stylesheet or a script.
- Nothing could compute it anyway: the build knows each page's path (the source path, the locale
  prefix, Vite's `base`), but not the site's origin. And `$url` is not the page's URL: it is the
  query parameters and the `:name` segments of `data-sn-path`, read in the browser. On a page with a
  fixed path it holds only the query, which differs per request, so the build cannot know it, `site`
  or not.
- `og:url` is a `<meta property>`, which binds, but has the same two gaps.

**Proposed: the site's origin is an option, and two names build on it.**

```js
sinter({ site: 'https://example.com' })
```

| Name | What it is | Example |
| --- | --- | --- |
| `$site` | the site's origin, as configured | `https://example.com` |
| `$canonical` | the page's canonical URL: `$site`, Vite's `base`, the locale prefix with `localePrefix`, and the page's path; no query, no hash | `https://example.com/en/about.html` |

- On a page with a fixed path both are build-time constants, written into the HTML: `og:url` in a head
  component is `<meta property="og:url" data-sn-attr="{ content: $canonical }">`, at no cost at run
  time. `$site` is for the other absolute URLs a head needs (`og:image`:
  `$site + '/og/about.png'`).
- Without `sinter({ site })`, reading either is a build error (`SN323`) that names the fix: "`$canonical`
  is the page's absolute URL, and the build does not know the site's origin: set
  `sinter({ site: 'https://…' })` in vite.config" (and the same for `$site`). It is reported where the
  name is read, in the page, component or layout, in `sinter check` and the LSP too. Without the error,
  the value would silently be missing from the HTML.
- `site` is an origin only (`https://example.com`, no path, no trailing slash). A site served under a
  path sets Vite's `base`, which `$canonical` includes after the origin. A path in `site` is a build
  error, so the path is never in two places.
- With `site`, every page with a fixed path gets `<link rel="canonical" href="…">` with `$canonical` in
  its head. A page or layout that writes its own `<link rel="canonical">` keeps it (a page whose
  content lives at another URL); `SN321` already allows only one. The redirect files of `localePrefix`
  are not pages and get none. Without `site`, no canonical link is written, as today.
- The same origin makes `hreflang` and `x-default` absolute (step 4).
- `$url` stays what it is: the query and the path parameters, known only in the browser, so a page
  that reads `$url` ships JavaScript, `site` or not. On a page matched by `sinter({ static })` that is
  `SN322`, and when the binding is one that wants the page's own address (`$url` in an `og:url`
  `<meta>`), the message points to `$canonical`.

A page whose path is a pattern (`data-sn-path="/article/:slug"`) is one HTML file for many URLs, so
the build cannot know its path. It is not static anyway: it reads `$url`. There `$canonical` is not a
constant: the early script computes it from `$site`, Vite's `base` and the browser's path (no query),
so a layout's `og:url` binding works on both kinds of page. For crawlers that
run no JavaScript, the server layer of embedded data (`embed: true`), which knows the request's path,
writes the canonical link and the bindings over `$canonical` into the HTML. Without it, such a page has
no canonical link in its HTML; the build report lists such pages once.

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
  the base language is prefixed too; every unprefixed path (the root too) is a redirect file that
  sends a visitor without JavaScript to the base language, and `x-default` points to the root; on a
  site with JavaScript, a page sets the `locale` cookie and the redirect file follows it, then
  `navigator.languages`, then the base; on a site without any, the redirect files have no script;
  sinter-axum redirects unprefixed paths by the cookie, then `Accept-Language`;
  `sinter({ static })` patterns match a page in every language; a static page ships no JavaScript in
  any language; an app page imports only its language's file and has no picker; assigning `$locale`
  is a build error; `data-sn-path`, Speculation Rules and next-page data carry the prefix. The dev
  server serves `/en/…`, `/de/…` and the redirect files as the build writes them.
- Canonical URLs: with `site`, every page with a fixed path has one canonical link, absolute, with
  `base` and the locale prefix; a page's own canonical link wins; `$site` and `$canonical` (the origin,
  `base`, the prefix and the path) in a `<meta content>` are written into the HTML; `hreflang` and
  `x-default` are absolute; on a pattern page the early script renders `$canonical` and the embed layer
  (Node and sinter-axum) writes the link and its bindings, with none in the HTML without it; without
  `site`, no canonical link is written and reading `$site` or `$canonical` fails with `SN323` at the
  element that reads it; a path in `site` fails the build; on a page matched by `sinter({ static })`,
  `$url` in an `og:url` `<meta>` fails with `SN322` pointing to `$canonical`.
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
5. A prototype of the virtual per-language inputs in Vite (every language prefixed, a redirect file
   at each unprefixed path), build and dev, before the rest of step 4.
6. Locale URLs (step 4): fixed-locale compilation, messages in attributes, build-time `date()` and
   `number()`, `localeUrl()`, `hreflang`, link rewriting, the redirect files and the `locale` cookie, the
   prefix in everything that knows page paths, sinter-axum's router and its redirects.
7. Canonical URLs (step 5): `site`, `$site`, `$canonical`, `SN323`, the canonical link, absolute
   `hreflang`, `$canonical` in the early script and the embed layer's canonical link for pattern pages,
   in Node and in sinter-axum.
8. Docs: a guide, `docs/static-pages.md` (what ships no JavaScript and why, the report line, the
   matcher, next-page data, the config module, multilingual sites and first-visit redirects on common
   hosts, canonical URLs), linked from `layouts.md` and `first-paint.md`; the config module's rule in
   `configuration.md`; locale URLs in the messages section; the README line "a small runtime ships
   with each page" becomes "with each page that needs one", and a CHANGELOG entry.

## Open questions

1. **The URL's form**: `$canonical` ends in the path as the file is named, with `index.html` as its
   directory (`/en/about.html`, `/en/`). Hosts that serve clean URLs (`/en/about`) need the
   other form: an option (`site: { url, cleanUrls: true }`), or always clean URLs, since Speculation
   Rules already match both?
2. **A sitemap**: with `site` and the list of pages known, the build could write `sitemap.xml`, with
   each page's languages as alternates. In scope here, or later?

Worth watching once it is used: locale URLs may turn out to be the better model for apps in general,
not only an optimization for static sites. If they do, making them the only model is a separate,
breaking change.

## Decisions

Settled in review, in the order they were discussed:

| Question | Decision | Section |
| --- | --- | --- |
| The config module on static pages | It does not run: everything `configure()` sets applies only while the runtime runs. The docs say code for every page goes in a script the layout includes | [What changes](#what-changes-on-a-page-that-ships-no-javascript) |
| Automatic or opt-in | Automatic: every page with nothing to run ships no JavaScript, with no option to ask for it. `sinter({ static })` is an optional assertion that fails the build (`SN322`) when a matched page would need the runtime | [Seeing why a page ships JavaScript](#3-seeing-why-a-page-ships-javascript) |
| Next-page data on static pages | Dropped; the static pages guide says so and points to `speculation: 'prerender'` | [What changes](#what-changes-on-a-page-that-ships-no-javascript) |
| Where the assertion goes | Only in the plugin's options, `sinter({ static: [...] \| true })`: no page attribute, nothing on layouts | [Seeing why a page ships JavaScript](#3-seeing-why-a-page-ships-javascript) |
| Multilingual static sites | In scope: one HTML file per page and language | [Multilingual static sites](#4-multilingual-static-sites-one-html-file-per-language) |
| Locale URLs | Every language prefixed, the base too (`/en/…`, `/de/…`): one URL shape for servers; each unprefixed path is a redirect file | [Multilingual static sites](#4-multilingual-static-sites-one-html-file-per-language) |
| Staying in a language | Each language's files link to that language's pages, so a visitor stays in the language they are in | [Multilingual static sites](#4-multilingual-static-sites-one-html-file-per-language) |
| Remembering the language | On a site that ships JavaScript, its pages record their language in a `locale` cookie, and the redirect file at each unprefixed path (`/about.html`, `/`) sends the visitor to it; on a site without any JavaScript, the redirect files go to the base language | [Multilingual static sites](#4-multilingual-static-sites-one-html-file-per-language) |
| The option's name | `sinter({ localePrefix: true })`: it says what the build does | [Multilingual static sites](#4-multilingual-static-sites-one-html-file-per-language) |
| One model or two | Both, chosen per site: the in-browser switch stays the default, `localePrefix` makes the whole site use locale URLs. Revisit once locale URLs have been used | [Multilingual static sites](#4-multilingual-static-sites-one-html-file-per-language) |
| A page's URL | `$site` is the origin from `sinter({ site })`; `$canonical` is the page's full URL built on it (origin, `base`, locale prefix, path). Reading either without `site` is a build error (`SN323`) that says to set it. `$url` stays the query and path parameters, read in the browser | [Canonical URLs](#5-canonical-urls) |
