# Proposal: languages as an axis of pages, on the page-per-entry engine

Status: proposed 2026-11-18, not started. It is the groundwork for
[messages-package.md](messages-package.md): that proposal's step 1 (the locale in the core) is this proposal's
step 1, and its runtime-switching parts fall away with decision 4 below.

`localePrefix` and `data-sn-pages` do the same thing at heart: build a page once per value, with that value as a
constant in the whole page, at a URL filled from it. Today they do it along two code paths that know about each
other. This proposal makes the language an implicit outer list of every page, built by the one engine
`data-sn-pages` already uses, and puts everything that is specific to languages in one module on top of it.

Decisions proposed:
1. **One engine for "a page per value".** A page is built once per **point**: one of its languages (with
   `localePrefix`) and, for a `data-sn-pages` page, one of its entries in that language. Listing the points,
   their URLs, collisions, the dev server, the sitemap, the embed manifest and the compiler's reuse of a page's
   walk all go through points, not through "a language" and "an entry" apart.
2. **The language is still special, in one place.** What only languages have (the URL prefix, links that stay
   in the language, `hreflang` and `x-default`, the choosers and the `locale` cookie, `<html lang>`, `$locale`,
   the formatters' and `order`'s locale) lives in `src/locales.ts`, a pure module the Vite plugin, the compiler
   and the server layer's manifest writer share. Nothing outside it tests for `localePrefix`.
3. **The locale is the core's own config.** `sinter({ locales: { base: 'en', list: ['en', 'de'] } })`. Until the
   messages leave the core, an inlang project still supplies it when the option is absent.
4. **One language per page, decided at build.** Runtime switching (`$locale = 'de'` on a page built without
   `localePrefix`) is deprecated and then removed: `$locale` is a constant of every build, a language is a page,
   and switching is a link (`localeUrl('de')`), swapped in with `swap: true`. To be confirmed: see
   [Open questions](#open-questions).
5. **The public API does not change.** `localePrefix: true` stays one line for the whole app, links are
   rewritten as today, and no page declares its languages. A generic axis (`data-sn-pages="lang in languages"`
   written by the app, or tenant and market axes) is not proposed: the core would still have to be told which
   list is the language, for the formatters, the links and `hreflang`. Tenants are the case for a second
   axis; [§6](#6-tenants-by-domain) says what works for them today and what that axis would need.
6. **Every built page is byte for byte what it is today**, for every example app and the e2e pages, through
   steps 1 to 4. Step 4 is also a speed change, measured.

## The case

### Two code paths

In the Vite plugin, both features turn source pages into virtual inputs in one map, `virtual`
(vite.ts:593), of `{ source, locale, page? }`. That is already the shape of a point, but it is filled twice:

| Concern | Languages | Entries |
| --- | --- | --- |
| inputs | `virtualOf(source, locale)` and `entries()` (vite.ts:654–660) | `pagesInputs()` (vite.ts:705), with its own loop over the languages inside it |
| a page's URL | `prefixed()` (vite.ts:743), and again in the compiler (compile.ts:4181–4183) | the pattern filled from the entry (`fillPattern`, sitemap-build.ts:47) |
| its URL in each language | `localeUrls()` (vite.ts:748) | `entryUrls()` (vite.ts:681), pairing translations by key in `entryLangs` |
| the chooser at the unprefixed URL | `chooserFor()` (vite.ts:2058) | `entryChooser()`, then the build's own loop (vite.ts:2265–2290) |
| dev | `devLocales()` (vite.ts:2097) | `devEntry()` (vite.ts:692), called with a language |
| collisions | none needed | an entry against the plain pages, per language (vite.ts:711–730) |
| links | `relocateHtml(…, locales)` guesses the language from the first path segment (page-urls.ts:90) | the entry's path |

In the compiler, a page gets `options.locale` (`{ name, urls, base }`) and `options.page` (`{ value, path, key }`)
separately. The language's setup (compile.ts:1288–1294) builds `localeUrl()` and also looks up the built-in
messages' namespace, so the locale and the messages are tied in the compiler too. `{$locale}` in a `file:` path is
substituted in its own place (compile.ts:6355–6358).

The language lists themselves come from the messages: `localePrefix` throws without them (vite.ts:1097–1099).

### A page is walked once per language

A `data-sn-pages` template is walked once for all its entries: each entry is evaluated again, not compiled
again (`fromTemplate`, compile.ts:845). The cache key includes the language (compile.ts:857), so a template is
walked once per language. A page without `data-sn-pages` is not reused at all (`fromTemplate` needs
`options.page`), so with `localePrefix` every plain page is compiled from scratch once per language. With two
languages that roughly doubles the compile time of its plain pages; with eight, roughly eight times.

The language changes what a page decides at build time in the same way an entry does: `$locale`, the messages'
text, `{$locale}` content and formatted values are constants that differ per point. So one walk can serve every
language of a page, under the condition the entries already have: the program is the same
(`sameProgram`), and only the evaluation differs.

### The runtime-switching mode doubles the rest

Without `localePrefix`, the built-in messages pick the language in the browser: a picker in the head, a
language file per page and language loaded before the page module mounts, base-language text hidden for up to
3 s (`data-sn-m`), and `$boot` waiting on `$ready()`. Every feature that reads the language has two cases:
constant per build, or a value that changes at runtime. No example, e2e page or the starter uses runtime
switching; the messages recipe and its tests do. `examples/multilingual-site` uses `localePrefix`.

## Goals

1. One listing of points from which inputs, URLs, collisions, dev serving, the sitemap, the embed manifest and
   the choosers all derive.
2. All language-specific code in `src/locales.ts`; no `localePrefix` test outside it.
3. Each page walked once for all its points when its program is the same, falling back per page as
   `fromTemplate` does now.
4. `locales` configurable without messages; `localePrefix` with `messages: false` works.
5. `$locale` constant in every build; the runtime picker, language files and hidden text gone (after the
   deprecation release).
6. Built output unchanged for every example app and e2e page through steps 1 to 4.

## Design

### 1. Points

```ts
// src/locales.ts and vite.ts
interface Point { source: string; locale: string | null; entry: Entry | null }
function pointsOf(source: string): Point[]   // languages (or [null]) × entries in that language (or [null])
```

- `pointsOf` replaces `virtualOf`, `entries()` and the language loop in `pagesInputs()`. A point's input file is
  its URL's file under its prefix (`de/about.html`, `de/blog/hallo.html`), as today.
- A language's entries are its own list (a `{$locale}` glob or a `perLocale` collection), as today. Translations
  are the points of one source whose entries have the same key, in different languages (`entryLangs` becomes a
  function of the points).
- One collision check over all points: two points at one file, or a point where a file in `public/` is, fail the
  build with both named (today's two messages).
- The dev server resolves a URL to a point (`pointAt(url)`), or to a source's chooser when the URL is a source's
  unprefixed path. `devLocales` and `devEntry` become that one function.
- The sitemap, the embed manifest's `pages` and `routes`, and the choosers are derived from the points.

### 2. The compiler gets a point

`CompileOptions` takes `point: { locale?: { name, urls }, entry?: { value, path, key } }` in place of `locale`
and `page` (the old names stay as aliases until the editor and `sinter check` move over, in the same step).

- The language is a constant of the page like the entry: `$locale` and the messages' text fold through the
  same evaluation (`decideFor`). The compiler's language setup builds `localeUrl()` from `src/locales.ts` and no
  longer looks up the messages' namespace: the messages get the language from the point like everything else.
- **Reuse across languages.** `fromTemplate`'s key drops the language, and it no longer requires an entry: a
  page with more than one point keeps its first walk and evaluates every other point against it, under
  `sameProgram`. A page whose program differs per language (a `{$locale}` source whose files differ in shape,
  a component chosen by the language) falls back to a walk per language, as a template with differing entries
  falls back today.
- The fallback is per page and silent, as now. A dev log names the pages that fell back, so the gain is
  visible.

### 3. `src/locales.ts`

Everything that knows a point's language is a language, all pure functions over `{ base, list }` and a point:

- `prefix(pattern, locale)`: the one prefixing, used by the plugin and the compiler (compile.ts:4181 and
  vite.ts:743 today).
- `urlsOf(point, points)`: the point's URL in each language that has it, for `localeUrl()`, `hreflang` and the
  sitemap's alternates.
- `chooser(source or entry, points)`: what `chooserFor`, `entryChooser` and the build loop write today, with
  `chooserHtml` and `hreflangTags` from locales-build.ts.
- `relocate`'s language: the point's, passed in, instead of guessed from the first path segment
  (page-urls.ts:90).
- `manifestLocales()`: the manifest's `locales` (`{ base, list, at }`) that `@tiaforge-ui/sinter/server`,
  sinter-axum and Sinter.AspNetCore read. The manifest format does not change, so the server layers do not.
- `choose(cookie, acceptLanguage, locales)`: the visitor's language at a chooser, the one rule the chooser
  script and the server layers implement.

### 4. `locales` in the core

```js
sinter({ localePrefix: true, locales: { base: 'en', list: ['en', 'de'] } })
```

- Without `locales`, an inlang project supplies it, as `readLocales` does now. Both given and different is an
  error naming both lists.
- `localePrefix` without any languages is an error naming the option. `localePrefix` with `messages: false`
  works when `locales` is given.
- `checkLocale` (locales-build.ts:30), which gives `sinter check` and the editor the base language, reads the same
  config.

### 5. One language per page

- **Deprecation release:** `$locale = …` and `setLocale()` on a page built without `localePrefix` warn (a new
  warning code), naming `localePrefix` and `localeUrl()`. A build with messages in more than one language and no
  `localePrefix` warns once.
- **Removal release:** without `localePrefix`, a build has one language, the base. `$locale` is read-only
  everywhere (SN203, as with `localePrefix` today). The picker script, the per-page language files, `data-sn-m`,
  `ready()`, `setLocale()`, the dynamic import and the wait in `$boot` go. The stream-handover gap that
  `$ready()` widens (stream-handover.md, "The case") goes with it.
- **What stays:** `$locale` as the build's language, `date()`, `number()` and `order` in it, and the
  bring-your-own route of configuration.md (a helper namespace and `configure({ locale })`) for an app that
  must switch in place and cannot prefix its URLs.
- The messages recipe moves to `localePrefix`, with a language link instead of a `<select>`.

### 6. Tenants by domain

The case: a multi-tenant shop, one tenant per domain (`acme-shop.com`, `globex-shop.com`), with the same pages,
each tenant's own products and its own texts on top of shared ones, in several languages.

**Today: one build per tenant**, and the reverse proxy maps each domain to its build's folder:

```sh
for t in acme globex; do TENANT=$t vite build --outDir dist/$t; done
```

- Each build sees its pages at `/`, so links, canonical links, the sitemap, `hreflang`, `data-sn-path` and
  same-page links are right for its domain with nothing new. `site` comes from the tenant
  (`sinter({ site: tenants[process.env.TENANT].origin })`).
- Content loaders get `env`, so `TENANT` picks the tenant's products and other content; `localePrefix` and
  `perLocale` work inside each build as for any app.
- Texts: the `messages` option takes an inlang project's path (vite.ts:1099), so each tenant can have its own
  project. Its single `pathPattern` means every shared text is repeated per tenant. The messages package
  removes that: its `pathPattern` is a list, merged in order, so a tenant's files override only the keys
  they change ([messages-package.md](messages-package.md#5-the-package)):
  `['./messages/{locale}.json', './tenants/' + env.TENANT + '/{locale}.json']`.
- The cost: N full builds that share nothing, and N folders to deploy.

**Later: one build, with the tenant as an axis whose values are origins.** The proxy rewrites
`acme-shop.com/*` to `/acme/*`, but a tenant written as a path prefix would be wrong: sinter would write
`/acme/cart/` into links, which the visitor sees as `acme-shop.com/acme/cart/` and the proxy maps to
`/acme/acme/cart/`. The axis needs a second kind of value besides the language's path prefix, an **origin**:

```html
<!-- src/layouts/shop.html: every page that uses the layout is built once per tenant -->
<html data-sn-pages="tenant in tenants" data-sn-origin="tenant.origin">
```

- **Declared by a layout**, once: every page that uses it is built once per tenant, with the page's own
  `data-sn-pages` entries inside each tenant and the languages around both. A point becomes language × the
  layout's lists × the page's entries, on the engine of §1.
- **Files under a folder, URLs without it**: the point is written under `dist/<tenant>/`, and every URL in it
  (links, canonical, sitemap, `hreflang`, `localeUrl()`, the runtime's path patterns) is the one its domain
  serves, with the tenant's origin where an absolute URL is needed. One sitemap per tenant.
- **Shared assets** stay at the root (`/assets/…`), written once, and the proxy passes them through.
- **Content per point**: `perLocale: true` becomes `per: ['tenant', 'locale']` on collections and content
  namespaces, and a loader gets the point's values (`load: ({ tenant, locale }) => …`). The messages package's
  file list then takes the tenant from the point instead of `env`.
- **The server layers** (`@tiaforge-ui/sinter/server`, sinter-axum, Sinter.AspNetCore) get a host → tenant map in
  the embed manifest, if the app embeds data.
- **Not language traits**: choosers, the `locale` cookie and `hreflang` between tenants do not apply; a tenant
  is never chosen for a visitor.

What it buys over one build per tenant: one build and one deploy, and §2's reuse, so a page is walked once for
all its tenants and languages when its program is the same. It is not in the plan below: it is worth building
once N builds are too slow or too awkward to deploy, which one build per tenant measures first.

## Plan

Each step ships on its own.

0. **Baseline.** A test that builds `examples/multilingual-site`, `examples/static-site`, `examples/realworld`,
   `examples/dashboard` and the e2e language pages and compares every emitted file with a recorded copy, so
   steps 1 to 4 are checked byte for byte. Compile timings for `examples/multilingual-site` and
   `bench/collections` with two and eight languages.
1. **`locales` in the core** (§4). Docs: configuration.md, static-pages.md#languages.
2. **`src/locales.ts`** (§3). A move: the language functions from vite.ts, compile.ts, page-urls.ts and
   locales-build.ts, with tests of their own. The output does not change.
3. **Points in the plugin** (§1). `pointsOf`, one collision check, one dev resolver, the sitemap, manifest and
   choosers from points. The output does not change; `vite.ts` loses its parallel paths.
4. **Points in the compiler** (§2). `point` in `CompileOptions`, the language through `decideFor`, reuse across
   languages, the fallback log. The output does not change; the timings from step 0 are measured again and
   written into this proposal.
5. **One language per page** (§5): the deprecation release, then the removal release (Breaking in the
   changelog). The messages recipe and llms.txt move with the first.

After step 5, [messages-package.md](messages-package.md) starts at its step 3 (content namespaces): its step 1 is
this proposal's step 1, and its step 2 shrinks to what `localePrefix` already does.

## Not in this proposal

- A public, generic axis: an app writing `data-sn-pages="lang in languages"`, or market axes. Tenants by
  domain have a design in [§6](#6-tenants-by-domain) but no step in the plan yet.
- Translated path segments (`/de/ueber-uns`).
- Messages: [messages-package.md](messages-package.md).

## Open questions

1. **Does anyone use runtime switching?** Nothing in the repository does beyond the messages recipe. A user of
   the published package might; the deprecation release is where they would say so. If someone does, decision
   4 becomes "runtime switching moves to the messages package's own runtime", outside the core.
2. **How often reuse across languages holds.** Pages whose `{$locale}` content differs in shape between
   languages fall back. Step 4 measures it on the examples; if most multilingual pages fall back, the step is
   still worth it for the single code path, but the speed claim goes.
3. **Where the language list is written** while messages are still in the core: the Vite config, the inlang
   settings, or both (with the mismatch error).
4. **`localeUrl()` on a page whose paths have parameters** reads `location.pathname` in the browser today
   (compile.ts:1292). With points, every point's URL is known at build for `data-sn-pages` pages; pages with
   `:params` but no entries still need the browser. Keep that split, or require entries for such pages?
