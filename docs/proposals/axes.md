# Proposal: axes of pages, with languages and tenants on one engine

Status: proposed 2026-11-18 as "languages as an axis of pages"; rewritten 2026-11-21 around a generic axis, after
review: tenants are in, runtime switching is removed (not deprecated), fallback chains are in. Every file and line
reference below is main's at `65a6a32`. It is the groundwork for [messages.md](messages.md), which builds content
namespaces and the messages on top of it.

`localePrefix` and a page per entry (`data-sn-for` on `<html>` or on a layout's tag) do the same thing at heart:
build a page once per value, with that value as a constant in the whole page, at a URL filled from it. Today they
do it along two code paths that know about each other, and nothing else can do it: a site built once per tenant
(a shop per domain, each with its own products and texts, in several languages) takes one `vite build` per tenant.

This proposal makes "a page per value" one engine, with **axes**: an axis is a list a page is built over, and a
page is built once per **point**, one value of each of its axes. The page's own entries are an axis, the
languages are an axis, and a tenant list is an axis. Languages keep what only languages have, in one module.

Decisions:
1. **One engine for "a page per value".** Listing the points, their URLs and files, collisions, the dev server,
   the sitemap and the other special files, the embed manifest, links between points and the compiler's reuse
   of a page's walk all go through points, never through "a language" or "an entry" apart.
2. **Axes are declared with `data-sn-for` on `<html>`**, as a page per entry is today, in a layout's `<html>` or
   on a page's layout tag, as an ordered list: `data-sn-for="tenant in tenants; locale in locales"`. The order is
   the nesting of their URLs (§2). A layout's lists come before the page's own. `localePrefix: true` stays, as a
   language axis outside all others, so today's apps do not change.
3. **An axis's values are a collection.** Any content loader can supply one; a tenant list is a collection
   like any other. Where a value is served comes from its entry: an `origin` field puts its pages on that
   domain, otherwise its key is a path segment. No new attribute.
4. **Languages are one kind of axis, special in one place.** The core's language loader (`languages()`) returns
   a collection the core knows to be the language: that axis gets choosers, the `locale` cookie, `hreflang`,
   `<html lang>`, `$locale` and the formatters' and `order`'s locale. All of that lives in `src/locales.ts`;
   nothing outside it tests for `localePrefix` or for a language.
5. **One language per page, decided at build.** Runtime switching is removed in one release (Breaking in the
   changelog), with no deprecation release first: `$locale` is a constant of every page, and switching is a link.
6. **Fallback chains** for languages (`de-AT → de → en`) and for any axis (a tenant → the shared texts).
7. **Every built page is byte for byte what it is today** for every example app and `test/fixtures/vite-i18n`,
   through the refactor steps (1 to 4), except where those use runtime switching (§7). The speed of many points
   is measured, not claimed: 20 tenants × 10 languages is 200 points per page.

## The case

### Two code paths

In the Vite plugin, both features turn source pages into virtual inputs in one map, `virtual`
(vite.ts:672), of `{ source, locale, page? }`. That is already the shape of a point, but it is filled twice:

| Concern | Languages | Entries |
| --- | --- | --- |
| inputs | `virtualOf(source, locale)` and `entries()` (vite.ts:733–739) | `pagesInputs()` (vite.ts:785), with its own loop over the languages inside it (vite.ts:803) |
| a page's URL | `prefixed()` (vite.ts:823), and again in the compiler (compile.ts:4503–4506) | the pattern filled from the entry (`fillPattern`, sitemap-build.ts:47) |
| its URL in each language | `localeUrls()` (vite.ts:828) | `entryUrls()` (vite.ts:761), pairing translations by key in `entryLangs` (vite.ts:674) |
| the chooser at the unprefixed URL | `chooserFor()` (vite.ts:2190) | `entryChooser()` (vite.ts:767), then the build's own loop (vite.ts:2397–2412) |
| dev | `devLocales()` (vite.ts:2229) | `devEntry()` (vite.ts:772), called with a language |
| collisions | none needed | an entry against the plain pages, per language (vite.ts:793–813) |
| links | `relocateHtml(…, locales)` guesses the language from the first path segment (page-urls.ts:90) | the entry's path |
| the template's entries | | `templatePages(file, locale)` (vite.ts:746), one compile per language |

In the compiler, a page gets `options.locale` (`{ name, urls, base }`) and `options.page` (`{ value, path, key }`)
separately. The language's setup (compile.ts:1387–1393) builds `localeUrl()` and also looks up the built-in
messages' namespace, so the locale and the messages are tied in the compiler too. `{$locale}` in a `file:` path is
substituted in its own place (compile.ts:6826–6829), and `order` collates in the page's language in two more
(compile.ts:6752, 6911). The language lists themselves come from the messages: `localePrefix` throws without
them (vite.ts:1216–1218). Choosing the visitor's language is written four times: the chooser script
(locales-build.ts:54), `choose()` in server.ts:256, sinter-axum (lib.rs:417) and Sinter.AspNetCore
(SinterMiddleware.cs:61).

Two newer features have no language case at all: a link template (`data-sn-href="/article/{a.slug}"`) is not
rewritten into the page's language as a literal `href` is, and the API's `signIn` is the unprefixed path.

### Tenants today

One build per tenant, with the reverse proxy mapping each domain to its build's folder:

```sh
for t in acme globex; do TENANT=$t vite build --outDir dist/$t; done
```

It works (content loaders get `env`; `site` comes from the tenant), but it is N builds that share nothing, N
folders to deploy, and every shared text repeated per tenant, since the messages read one `pathPattern`. A tenant
can also not be written as a path prefix inside one build: sinter would write `/acme/cart/` into links, which on
`acme-shop.com` the proxy maps to `/acme/acme/cart/`. A tenant needs a value whose pages are written under a
folder and whose URLs are written without it: an **origin**.

### A page is walked once per language

A page-per-entry template is walked once for all its entries: each entry is evaluated again, not compiled
again (`fromTemplate`, compile.ts:934). The cache key includes the language (compile.ts:938), so a template is
walked once per language, and a page that is not a template is not reused at all (`fromTemplate` needs
`options.page`). The linker of [compile-once.md](compile-once.md) (5) shares definitions across pages that read
alike, a page's other languages included where a definition reads nothing of the language.

Two things keep a language from sharing a walk: `localeUrl()` compiles to a function holding the page's URL
table (compile.ts:1391), which marks the page `readsUrl` (expr.ts:483) so that `entryProgram()` refuses it
(compile.ts:1711–1713); and the messages are stubbed per language from `baseMessages` (compile.ts:7155–7166). At
200 points per page, a walk per point is the build's cost; one walk per page, evaluated per point, is what makes
tenants × languages practical.

### Runtime switching

Without `localePrefix`, the built-in messages pick the language in the browser: a picker at the start of the
shared head script (`I18N_PICKER`, i18n-build.ts:143; vite.ts:1459), a language file per page and language,
base-language text hidden for up to 3 s (`data-sn-m`), `$boot` waiting on `$ready()` (compiler/index.ts:363), the
per-page early file's wait (early.ts:171–193) and the swap's dictionary merge (swap-run.ts:142–175, 380). It does
not fit an axis (one page per value, decided at build), it would stay a special case of the language alone (a
tenant is never switched in the browser), and every per-language resource would need its own runtime file and
wait. No example, e2e app or the starter uses it; the messages recipe, `e2e/swap-csp`'s inlang project,
`test/behaviour/messages.test.ts`, `test/compiler/locale.test.ts` and `test/fixtures/vite-i18n` do.

## Goals

1. One listing of points from which inputs, files, URLs, collisions, dev serving, the special files, the embed
   manifest, the choosers and links between points all derive.
2. Any number of axes on a page, in the order the page declares, with tenants on their own domains in one build.
3. All language-specific code in `src/locales.ts`.
4. Each page walked once for all its points when its program is the same, falling back per page.
5. `$locale` constant in every build; the runtime picker, language files and hidden text gone.
6. Built output unchanged for every example app and `test/fixtures/vite-i18n` through steps 1 to 4.

## Design

### 1. Points

```ts
// src/points.ts
interface Axis { name: string; list: Collection; language: boolean }   // `tenant in tenants`
interface Point { source: string; values: Array<{ axis: Axis; entry: unknown }> }   // outer to inner
function pointsOf(source: string, axes: Axis[]): Point[]
```

- A page's axes are, outer to inner: the language when `localePrefix` is on and the page declares none, then
  its layout's lists, then its own. A page that declares none has one point.
- An inner list may depend on outer values: `file:/content/{tenant.key}/{$locale}/posts/*.md` (today's
  `{$locale}`, generalized to any outer axis variable), or a collection loaded per point (§3). A list that is the
  same at every outer value is listed once.
- **Files and URLs.** A point's file is its source's file under its values' segments, outer first
  (`dist/acme/de/blog/hallo.html`). Its URL is the same path without the segments of values on an origin, at
  that origin (`https://acme-shop.com/de/blog/hallo`).
- **One collision check** over all points: two points at one file, a point where a file in `public/` is, or a
  value's segment equal to a top-level page or folder, fail the build with both named.
- **Translations** of an entry are the points that differ only in the language and whose entries have the same
  key (`entryLangs` becomes a function of the points). The same rule pairs a page's points across any axis, for
  links from one tenant's page to another's (§5).
- The **dev server** resolves a URL to a point (`pointAt(url)`), or to a chooser (§4). In dev, every axis is a
  path segment, origins included: `/acme/de/cart/` in dev is `https://acme-shop.com/de/cart/` in the build, so
  no hosts or proxy is needed locally. `devLocales` and `devEntry` become `pointAt`.
- The sitemap, the embed manifest's `pages` and `routes`, the choosers, the `_redirects` rules and SN343's
  broken-entry-link check (`brokenEntryLinks`, vite.ts:2425) derive from the points.

### 2. Declaring axes

```html
<!-- src/layouts/shop.html -->
<html data-sn-for="tenant in tenants; locale in locales" data-sn-props="{ title: string }">
```

```html
<!-- src/product.html -->
<shop-layout data-sn-path="/product/:slug" data-sn-for="product in products" data-sn-with="{ title: product.name }">
  <sn-resource name="products" src="file:/content/{tenant.key}/{$locale}/products/*.md"></sn-resource>
  …
</shop-layout>
```

- `data-sn-for` on `<html>` (or a layout's tag) takes one or more `item in list`, separated by `;` (a `,` can be
  part of a list's expression), outer first.
  Each list is a constant the page or layout reads: a `file:` glob, as today, or a collection (`tenants`,
  `locales`).
- A layout's lists are outer to the page's: a product page is tenant × language × product, at
  `acme-shop.com/de/product/schuh`. `data-sn-for="locale in locales; tenant in tenants"` in the layout gives
  language × tenant: `/de/acme/product/schuh` when both are path segments. An axis on an origin is always
  outermost, whatever the order (a domain cannot be inside a path), so for a tenant per domain both orders build
  the same files.
- **Pages outside an axis** are pages that do not declare it: a portal page that does not use `shop-layout` is
  built once, at the site's root.
- Each item (`tenant`, `locale`, `product`) is a constant of the whole page, as an entry is today. `$locale` is
  the language axis's item where there is one, so `{$locale}` keeps working.
- `localePrefix: true` is short for a language axis outside everything on every page that declares none: today's
  apps need no markup. A page that declares `locale in locales` itself sets where the language sits.
- Layouts do not nest (layouts.md), so one layout and one page give every axis a page needs; the list is not
  limited to two.

### 3. Axis values, origins and per-point content

An axis's list is a collection (resources.md#collections). Its entries' key is the value's name and, by default,
its path segment.

```ts
// src/sinter.content.ts
import { collection, languages } from '@tiaforge-ui/sinter/content';

export const tenants = collection({
  key: 'key',
  load: async () => [
    { key: 'acme', origin: 'https://acme-shop.com', name: 'Acme', theme: { accent: '#d33' } },
    { key: 'globex', origin: 'https://globex-shop.com', name: 'Globex', theme: { accent: '#36c' } },
    { key: 'demo', name: 'Demo', theme: { accent: '#888' } },   // no origin: served at /demo/ on `site`
  ],
});

export const locales = languages({ base: 'en', list: ['en', 'de', 'de-AT'] });
```

- **`origin`** (a field of the entry, or `collection({ origin: 'domain' })` naming another field): the value's
  pages are served there, written under `dist/<key>/`, with every URL in them (links, canonical, sitemap,
  `hreflang`, `localeUrl()`, the runtime's path patterns) for that domain. Without it, the key is a path segment
  on `site`. Shared assets stay at the root (`/assets/…`), written once; the proxy serves them on every domain.
- **`languages({ base, list, fallbacks?, domains? })`** is the core's language loader: a collection of
  `{ tag }` entries marked as the language. `domains: { de: 'https://example.de' }` is its form of `origin`.
  An app with an inlang project can take the list from it:
  `languages(inlangLocales('project.inlang'))`, with `inlangLocales` from `@tiaforge-ui/sinter/messages` (the
  core does not read inlang files, [messages.md](messages.md)). Until an app declares `languages()`, the built-in
  `messages` option still supplies the list, as `readLocales` does now.
- **Per-point content.** `collection({ per: [tenants, locales], load })` is loaded once per point of those axes,
  and `load` gets the point's entries: `load: ({ value, files }) => files(\`content/${value(tenants).key}/*.md\`)`.
  `perLocale: true` stays, as `per: [locales]` with `ctx.locale`. A page reads the collection's value at its own
  point.
- **Theme and other tenant traits** are data: `tenant.theme.accent` in a `style` binding, `tenant.logo` in an
  `<img src>`, folded into each point's HTML at build.
- **Files per tenant** (a tenant's own header component, a stylesheet Vite bundles) are not in this proposal, but
  the compiler resolves components and layouts through one function that takes the point (§8), so override
  folders can be added later without a refactor.

### 4. `src/locales.ts`: what only the language axis has

Pure functions over the language list and the points:

- `prefix(path, point)`: a point's URL from its values' segments and origins, the one prefixing used by the
  plugin and the compiler (compile.ts:4503–4506 and vite.ts:823 today), by link templates and the API's
  `signIn`. It is generic over axes and lives in `src/points.ts`; `src/locales.ts` adds only the language's own
  segment rules (`paths`, below).
- `chooser(source or entry, points)`: what `chooserFor`, `entryChooser` and the build loop write today, with
  `chooserHtml` and `hreflangTags` from locales-build.ts. A chooser is written only for the language axis: at a
  page's URL without its language segment.
- `hreflang` and the sitemap's alternates, `<html lang>`, the `locale` cookie, `$locale`, the formatters' and
  `order`'s locale.
- `relocate`'s language: the point's, passed in, instead of guessed from the first path segment (page-urls.ts:90).
- `manifestLocales()`: the manifest's `locales` (`{ base, list, at }`) that `@tiaforge-ui/sinter/server`,
  sinter-axum and Sinter.AspNetCore read.
- `choose(cookie, acceptLanguage, locales)`: the visitor's language at a chooser, the one rule the chooser
  script and the three server layers implement today as four copies, with one set of test cases (a JSON file of
  tags, lists and answers) run in all three languages' suites.
- `chain(locale, locales)`: the languages a value is looked up in (§6).

**At a URL without a value** of an axis that is not the language (`/cart/` on a site whose tenants are path
segments), nothing is written: a tenant is never chosen for a visitor. An app that wants a page there writes one
that does not declare the axis.

#### URL segments

A language's segment is its tag (`/de-AT/`), or `paths: { 'de-AT': 'at' }`; `codes: { no: ['nb', 'nn'] }` are
extra tags a visitor may send for it. The tag stays the language everywhere (`$locale`, `<html lang>`,
`localeUrl('de-AT')`, the cookie, `{$locale}`, `per`, the messages' files, the chains); the segment is only the
URL and output folder, through `prefix()`. `hreflang` lists the tag and each code, at its URL. Without `paths`
and `codes` the output does not change.

### 5. Links between points

A link keeps the current point's values for every axis the target page has too: on acme's German pages, `/cart/`
is acme's German cart; a link to a page outside the tenant axis drops the tenant (and is absolute when the tenant
is on an origin). What a link needs beyond that comes from where it is written:

1. **Inside a loop over an axis's list**, a link to a page with that axis takes the loop's item:
   `<template data-sn-for="t in tenants"><a href="/shop/">` on a portal links to each tenant's shop.
2. **Under a variable that holds an entry of the axis's list** (`data-sn-with="t = tenants.acme"`), likewise.
3. **A switcher** (the same page for every tenant, or every language) is case 1 with a link to the current
   page. `localeUrl('de')` stays for the language, and `axisUrl(tenants, 'acme')` is its general form.
4. **A link the page cannot derive** (to a tenant's page, from a page outside the tenant axis, with no loop or
   variable) is a build error naming the link and the axis, until a use case says otherwise. For the language
   axis it is never an error: such a link goes to the chooser, as today.
5. **Links that exist only in the browser** (a URL from the API on a page outside the axis) are left as written;
   in dev, one that lands on a path only an axis has logs a warning naming it.

- **Link templates** are prefixed like literal links. When the template's literal start fixes the page
  (`/article/{slug}`), the prefix is compiled in. When it starts with a value (`{base}/article`), the compiled
  template calls `prefix()` on what it produces, with the point's segments as a constant: a same-origin path
  that is one of the site's page patterns (the runtime has them for swaps and same-page links) and does not
  start with a segment already gets the point's; anything else (another origin, the API, `public/`) is left as
  written. Only pages with such a link ship that function.
- **The API's `signIn`**, when it is one of the site's pages, is that page at the current point.
- **Across origins**, a link is absolute and loads the page, as any cross-origin link (no same-page link, no
  swap).
- SN343 (a link to an entry that does not exist) checks against the target's points.

### 6. Fallback chains

Each axis value has a **chain**: the values a missing value is looked up in, in order.

- **Languages**: the default drops subtags, one at a time, keeping the languages the site has, then the base,
  as BCP 47 lookup does (RFC 4647): `de-AT → de → en`, `zh-Hant-TW → zh-Hant → zh → en`.
  `languages({ fallbacks: { 'de-CH': ['de-AT', 'de'] } })` replaces a chain before the base, which always ends it.
  A chain that names a language the site does not have, or a cycle, is an error.
- **Other axes**: a value's chain is its `fallback` field (another entry's key, `globex-eu → globex`), then
  **none**: the content shared by all values, a collection's load at no value of that axis. A collection with no
  shared content returns an empty list there.
- **Several axes**: the lookup keeps the innermost axis's value longest. With tenant outside language
  (`tenant in tenants; locale in locales`), acme in `de-AT` looks up acme/de-AT, shared/de-AT, acme/de, shared/de,
  acme/en, shared/en: a German visitor gets German before acme's own English. Declaring language outside tenant
  reverses it: the tenant's texts come first.
- **Choosing the visitor's language** walks the visitor's tags in their order (cookie, then
  `Accept-Language`) and, for each, first the site's language with that tag, then the one its chain names, then
  a site language with the same language part (`de` reaches `de-DE` when the site has no `de`; of several, the
  first in `list`), the direction missing today. The three server layers read the chains from the embed manifest
  (`locales.fallbacks`, a manifest version bump).
- **Content** takes an opt-in: `fallback: true` on a collection or a `file:` source. An entry the point lacks is
  then built from the first point of its chain that has it, with the page's own chrome and messages, and a
  canonical link to that point's page; such a page is not in the sitemap or the `hreflang` alternates. Without
  the option, the entry has no page there, as today.
- **Messages** look up each key along the chain, at build ([messages.md](messages.md)). SN522 reports only the
  keys that reach the end of the chain.
- **Formatters** keep the page's own tag (`Intl` negotiates its data).

### 7. One language per page

Runtime switching is removed in one release (Breaking in the changelog):

- Without a language axis, a build has one language, the base, and `$locale` is read-only everywhere (SN203,
  as with `localePrefix` today). Writing it is an error naming `localePrefix` and `localeUrl()`.
- What goes: the picker (`I18N_PICKER`) at the start of the shared head script, the per-page language files
  (`languageFiles`, vite.ts:542) and `pickerTag` (vite.ts:685), `data-sn-m`, `ready()`, `setLocale()`,
  `onLocale()`, the dynamic import and the wait in `$boot` (compiler/index.ts:363–373), the early file's
  dictionary wait (early.ts:171–193), and the swap's dictionary merge (swap-run.ts:142–175). The stream-handover
  gap that `$ready()` widens ([stream-handover.md](stream-handover.md#the-case)) goes with it. What `fixed()`
  (messages.ts:80) does becomes the only mode.
- What stays: `$locale` as the page's language, `date()`, `number()` and `order` in it, and the bring-your-own
  route of [configuration.md](../configuration.md) (a helper namespace and `configure({ locale })`) for an app
  that must switch in place.
- The messages recipe moves to `localePrefix`, with a language link instead of a `<select>`; `e2e/swap-csp`'s
  inlang project, `test/fixtures/vite-i18n` and the tests of runtime switching move with it or go.

### 8. The compiler gets a point

`CompileOptions` takes `point: Array<{ axis, entry }>` in place of `locale` and `page` (the old names stay as
aliases until the editor and `sinter check` move over, in the same step).

- Every axis item is a constant of the page, evaluated through `decideFor` (compile.ts:1726). The language
  setup builds `localeUrl()` from `src/locales.ts` and no longer looks up the messages' namespace.
- **Points as data, not code.** `localeUrl()`'s and `axisUrl()`'s tables and a link template's segments are
  constants of the point, read by the evaluation, not literals in the function (compile.ts:1391), so the program
  is the same across points; `readsUrl` (expr.ts:483) is set only where the browser's `location` is read.
- **One walk per page.** `fromTemplate`'s key drops the language, and it no longer needs an entry: a page keeps
  its first walk and evaluates every other point against it, under `sameProgram` (compile.ts:1716). A page whose
  program differs at some point (a `file:` source whose files differ in shape, a component chosen by a value)
  falls back to a walk for that point, as a template with differing entries does today. A dev log names the
  pages that fell back.
- **The linker keeps its own check** (compile-once.md (5)): a definition that reads an axis item reads the point,
  so it links across points where its program is the same.
- **Components and layouts are resolved through one function that takes the point**, today always returning
  the shared file. Per-value override folders are an addition to that function later.

### 9. Special files

Written per point of the axes that change URLs, outermost first: `404.html`, `robots.txt` and `sitemap.xml` per
origin (each listing its own URLs, with `hreflang` alternates across origins), and per path-segment value where
the host serves one per folder (a `404.html` under `dist/demo/`). A 404 page declares its axes like any page;
one that declares none is the site's.

### 10. Server layers

The embed manifest describes points as it describes pages and locales today. Whether the three server layers need
more than they have (a host → folder map for origins) is decided once steps 3 and 8 have fixed the manifest's
shape; until then, origins are served through the reverse proxy, with rules for nginx, Caddy and Apache in the
guide.

## Plan

Each step ships on its own.

0. **Baseline.** *Done 2026-11-21.* `npm run baseline` (scripts/baseline.mjs) builds `examples/multilingual-site`,
   `examples/static-site`, `examples/realworld`, `examples/dashboard`, `e2e/swap-csp` and `test/fixtures/vite-i18n`
   and compares every emitted file with the hashes recorded in `test/baseline/` (`--record` records, `--keep <dir>`
   keeps the builds to diff), so steps 1 to 4 are checked byte for byte. It is a script, not part of `npm test` or
   CI: the baseline is this work's, and other changes on main re-record it. Compile timings are in
   [bench/axes](../../bench/axes/README.md) (50 pages and a blog, 1, 2 and 10 languages, 1 and 20 tenants, with and
   without `SN_NO_LINK`): a language costs about 10 ms per page, the linker saves 3 to 9% across languages, and 20
   tenants × 10 languages take 139 s, 20 times one tenant. `scripts/size.mjs` budgets the multilingual example's
   German status page (its scripts and its HTML). Found on the way and fixed: `sinter check` on a page per entry in
   a subfolder failed in generated code.
1. **`languages()` in the core** (§3). *Done 2026-11-21.* The language list without the messages; `localePrefix` with
   `messages: false`. The content module is loaded before the build's inputs are listed, so its `languages()` decides
   them; `perLocale` collections load for its languages, and the snapshot records them for `sinter check` and the
   editor. Docs: configuration.md, static-pages.md#languages.
2. **`src/points.ts` and `src/locales.ts`** (§1, §4). A move of the language functions from vite.ts,
   compile.ts, page-urls.ts and locales-build.ts, with tests of their own. The output does not change.
   *`src/locales.ts` done 2026-11-21:* `prefixPaths` (the plugin's and the compiler's prefixing, one function),
   `languageOfFile`, `chooseLanguage` and `requestLanguages` (the server layer's `choose()`, and a test that the
   chooser page's script answers the same for the same tags), `manifestLocales`, `chooserHtml` and `hreflangTags`.
   `locales-build.ts` keeps only what reads files (the inlang project, the check's language). What depends on the
   list of points (`localeUrls`, `entryUrls`, the choosers' URLs) moves with `src/points.ts` in step 3.
3. **Points in the plugin** (§1). `pointsOf` for the language and a page's entries, one collision check,
   `pointAt` in dev, the special files, manifest, rules and choosers from points. The output does not change.
   Then, as its own commit since it changes output: link templates and `signIn` at the page's point (§5).
   *Done 2026-11-21:* `src/points.ts` (`listPoints`: the points, their files, the translations, the collisions in one
   pass), from which the plugin's inputs, its choosers and the dev server's `pointAt` derive. Then link templates and
   `signIn` in the page's language: `inLanguage` in src/locales.ts prefixes a literal start that names one of the
   site's pages (its complete segments matching a page's path, `:name` matching any), at build time; a start that
   begins with a value is still left as written (the runtime half of §5 comes with step 6, where the point's
   segments are data).
4. **Points in the compiler** (§8). `point` in `CompileOptions`, URL tables as data, one walk per page, the
   point-aware component resolver, the fallback log. The output does not change; step 0's timings are measured
   again and written into this proposal.
   *Measured 2026-11-21, not built.* A prototype made the kept walk read the point (`$locale`, `localeUrl()` and
   `$canonical` as `$.$pt`, `{$locale}` lists and per-language collections loaded again per point) and let
   `fromTemplate` share it across a page's languages; the baseline held. On bench/axes's 10-language app it saved
   nothing (7.2 s against 7.0 s): every page there reports nothing left to decide after its walk (its messages and
   `$locale` fold during it), so it compiles in one pass already, and the shared walk is the deciding walk, not the
   one that writes each point. What remains per point is that writing walk (27% of the build) and the page's
   description (13%, a describe-only compile per point), whose outputs differ per language. Sharing them needs a
   compile whose output is parametric in the point, which is a proposal of its own; open question 1 is answered: the
   speed claim goes, and step 6 (one build over tenants, sharing the build's start and the project) is where a
   site with tenants gains. Found on the way: `fromTemplate` is off whenever the compile type-checks (`check`), which
   the build does whenever TypeScript is installed, so the page-per-entry sharing of compile-once.md (3) does not
   run in most apps' builds. The type check's unit must come from a first pass (compilePasses' note on unrolled
   rows), so that needs its own fix. The point-aware component resolver moves to step 6, where tenants need it.
5. **Runtime switching removed** (§7). Breaking in the changelog. The messages recipe, llms.txt and the tests
   move. The baseline is recorded again.
   *Done 2026-11-21*, in two commits: (a) a build without `localePrefix` compiles every page in the messages' base
   language (the compiler's `locale` with `prefix: false`), with no picker and no language files, changing only
   `e2e/swap-csp` (moved to `localePrefix`) and `test/fixtures/vite-i18n`; (b) the runtime that served switching
   goes (`setLocale`, `onLocale`, `ready`, `use`, the early file's and the swap's dictionary waits, the picker),
   which only shrank files: the shared head script by 364 B, the swap's rest by 757 B, each page's head script by
   5 B. `render()` compiles a page with messages in its one language, as a build does.
6. **Axes declared in markup** (§2, §3): `;` lists in `data-sn-for`, collections as lists, outer variables in
   `file:` paths, `per`, `origin` (files under a folder, URLs without it, absolute links across origins, a sitemap
   per origin), links between points (§5), `axisUrl()`, the special files per point (§9). A test site with
   tenants on origins and on path segments, each in three languages, built and served through a proxy config in
   e2e. A recipe: a shop per tenant. Docs: static-pages.md, with the proxy rules.
7. **Fallback chains** (§6): `chain`, the new direction in `choose`, the shared test cases in the three server
   layers, the manifest's `fallbacks`, chains of other axes, `fallback: true` for content.
8. **Language segments and domains** (§4 "URL segments", §3 `domains`): `paths`, `codes`, and languages on
   their own domains, on step 6's origins.
9. **Server layers**, if §10 finds work beyond the manifest they read today.

## Not in this proposal

- Files per axis value (a tenant's own components, layouts or bundled stylesheets): later, on §8's resolver.
- Translated path segments (`/de/ueber-uns`).
- Switching a language in the browser (§7).
- Content namespaces and the messages: [messages.md](messages.md).

## Open questions

1. **How often one walk per page holds.** Pages whose content differs in shape between points fall back. Step 4
   measures it; if most fall back, the step is still worth it for the single code path, but the speed claim goes.
2. **`localeUrl()` and `axisUrl()` on a page whose paths have parameters and no entries** (`/user/:id`) read
   `location.pathname` in the browser, as `localeUrl()` does today (compile.ts:1391). The proposal keeps that
   split; requiring entries for such pages is the alternative.
3. **Many points in dev.** The dev server compiles a point when it is opened. Whether 200 points of a page need
   more than that (sharing the walk in dev as in the build) is known after step 4.
