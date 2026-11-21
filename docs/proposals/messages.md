# Proposal: content namespaces, with the messages as one replaceable loader on them

Status: proposed 2026-11-18 as "messages as a package"; rewritten 2026-11-21 after review: the messages stay in
this repository and in the core package, at `@tiaforge-ui/sinter/messages`, but the core reaches them only through
a general mechanism, so an app can replace them with its own loader and ship nothing of them. File and line
references are main's at `65a6a32`. It builds on [axes.md](axes.md): languages and tenants are axes, a page has one
language decided at build (runtime switching is removed there), and values fall back along chains.

It revisits the built-in messages as [spec.md](../spec.md#messages) describes them (from the inlang files, one
file per page and language, decided 2026-11-08 and 2026-11-10), keeping every reason given there except the runtime
picker, which axes.md removes. Paraglide was considered as the engine and dropped: its message functions carry
every language's text, its runtime picks the locale on its own, and its runtime was most of the early chunk when
the built-in messages were decided.

Decisions:
- **Messages are content.** The core gains one general mechanism, the **content namespace**: a loader's entries
  called as `ns.a.b(args)` through the loader's own formatter, cut down to the entries a page calls, folded into
  the HTML at build. The core knows nothing of messages, inlang or `@tiaforge-ui/sinter/messages`.
- **The default implementation stays here**, as a subpath of the core package, `@tiaforge-ui/sinter/messages`,
  with its code in `src/messages/`. It is not published separately. An app that registers another namespace (its
  own, or a wrapper over another library) and never imports the module ships none of it: the package is
  `sideEffects: false` and the core has no import of it.
- **The module reads the inlang message format** with nested keys (`m.navigation.contact.email()`), complex
  messages (plural, ordinal, exact numbers, a choice on an input, `*`, several selectors), `\{` escapes and a list
  of files, and per-tenant files over shared ones.
- **Nothing changes for a page** that calls `m.key()` today, beyond one line of config. A page whose messages are
  plain strings ships the same bytes as today, measured in step 0 and checked in every step after it.

## The case

The built-in messages (`src/messages.ts`, `src/i18n-build.ts`, `src/locales-build.ts`) are known by name in the
compiler's language setup and lazy helpers (compile.ts:1392, 1410), its evaluation stubs and base text
(compile.ts:7155–7166, 7188–7189), the next-page module's parts (compile.ts:8810), the page module's imports
(compiler/index.ts:414–420), the Vite plugin's `collect` and language files (vite.ts:686–694, 1459–1506), the
per-page early file's dictionary wait (early.ts:171–193), the swap's dictionary merge (swap-run.ts:142–175),
`project.ts` and `fold-check.ts`. An app that wants other messages, or a glossary or legal snippets called the same
way, cannot have them: only this one module gets per-page cutting and build-time folding.

The message syntax is the narrowest part. `readMessages` (i18n-build.ts) accepts only flat JSON whose values are
plain strings with `{param}` placeholders:

| inlang message format (4.6.0) | sinter today |
| --- | --- |
| nested objects, addressed with dots (`navigation.contact.email`) | error: a key must be an identifier, a value a string |
| complex messages: `[{ declarations, selectors, match }]` (plural, ordinal, exact numbers, a choice on inputs, `*`) | error: "no plurals or variants yet" |
| `\{`, `\}`, `\\` escapes | no escape: `{word}` is always a placeholder |
| `pathPattern` as a list of files, merged | one pattern |
| formatted placeholders (`{rate: number style=percent}`) | none: format in markup and pass text |
| markup (`{#b}…{/b}`, `{#icon/}`) | none |

Plurals are the gap teams hit first: `count === 1 ? m.one() : m.many()` in markup is wrong for most languages
(Polish, Russian and Arabic have three to six plural forms). Dot notation is the second: most existing translation
files are nested. With tenants ([axes.md](axes.md)), a third: a tenant's texts over the shared ones, without
repeating every shared text per tenant.

## Goals

1. A content namespace ships only the entries a page calls, for any loader: messages, a glossary, feature texts,
   snippets.
2. Its calls fold into each point's HTML at build, and are looked up along the point's fallback chain.
3. `@tiaforge-ui/sinter/messages` reads the inlang message format with nested keys, complex messages, escapes,
   lists of files and per-tenant files; types every message; formats in the browser and at build; and reports
   what it cannot do.
4. A page with plain-string messages ships the same bytes as today; a page with a plural message ships the
   plural's selection code and nothing else of the formatter.
5. The core has no code that knows the module, the inlang format, or messages at all. Its tests use a loader that
   is not messages, and a build that does not use the module has no trace of it.

## Design

### 1. Content namespaces

A **content namespace** is a collection with two more things: a name its entries are called by, and a formatter
module that turns an entry and its arguments into a value. Entries are keyed by dotted ids. Any content loader
may return one:

```ts
// src/sinter.content.ts
import { namespace } from '@tiaforge-ui/sinter/content';
import { tenants, locales } from './axes';

// an app's own: legal snippets per tenant and language, one markdown file each (its slug is its id): legal.imprint()
export const legal = namespace({
  name: 'legal', per: [tenants, locales], format: '/src/legal-format.ts',
  load: ({ value, files }) => files(`content/legal/${value(tenants)?.key ?? 'shared'}/${value(locales).tag}/*.md`),
});
```

- `format(entry, args, locale)` is a pure function in the formatter module, so it folds at build like any helper.
- The compiler resolves `legal.imprint(p)` to the entry `imprint` at the page's point, and the call
  `format(entry, p, $locale)`. An unknown id is `SN206` with a suggestion over the namespace's ids, in every build.
- **Cut per page.** A page ships only the entries it calls: its markup's calls and the ids its app modules call
  (today's `moduleKeys` for `m.key`, generalized). A computed entry (`m[k]`) is an error, since the page's data
  could not be cut; a string literal (`m['nav-home']`) is a fixed entry.
- **Folded at build.** A call over the page's point and constant parameters is folded into the HTML, as helper
  calls over constants are (static-pages.md). A call over live data runs in the browser, with the page's entries
  compiled into its module. The compiler's special cases for the messages module (compile.ts:7155–7166 and
  7188–7189) become this rule.
- **Along the chain.** An entry missing at the page's point is looked up along the point's chain
  ([axes.md](axes.md#6-fallback-chains)): `per: [tenants, locales]` loads every point of those axes and the
  shared value of each (`value(tenants)` is `undefined` there), and each id resolves to the first point that has
  it. A namespace may set `fallback: false` to make a missing id an error instead.
- **Names.** A namespace's name is final: the same name as a helper namespace or another content namespace is an
  error naming both.
- **Types** come from the loader: a namespace's `load` return type gives each entry's type, its formatter's
  signature the arguments. A loader may instead generate a declaration file (the messages module does).
- `sinter check` and the editor need the ids without running loaders. A loader that only reads the project's
  files says so (`static: true`), and check and the editor run it; others use the build's snapshot.
- **Cutting other constant resources** by the paths a page reads is not in this proposal: a `data-sn-for` over a
  list reads every entry, so the gain is in objects, not lists. `fields` stays.

### 2. The messages module

`src/messages/`, exported as `@tiaforge-ui/sinter/messages`:

```ts
// src/sinter.content.ts
import { inlang } from '@tiaforge-ui/sinter/messages';
export const messages = inlang({ project: 'project.inlang', namespace: 'm' });
```

```html
<h1 data-sn-text="m.inbox.title()"></h1>
<p data-sn-text="m.inbox.unread({ count: inbox.unread })"></p>
```

- **`inlang()`**, the loader. It reads `project.inlang/settings.json` (`baseLocale`, `locales`,
  `plugin.inlang.messageFormat.pathPattern`, a string or a list merged in order), flattens nested objects to dotted
  ids, and parses each message into a small JSON form (below). It returns a content namespace (`m`) per language.
- **Per tenant**: `inlang({ project, per: [tenants], tenantFiles: (t) => \`./tenants/${t.key}/{locale}.json\` })`.
  The project's own files are the shared texts; a tenant's files hold only the keys it changes, and the chain
  does the rest.
- **`inlangLocales(project)`** gives `languages()` ([axes.md](axes.md#3-axis-values-origins-and-per-point-content))
  the project's base and list, so an app keeps one list, in `settings.json`.
- **The formatter**, a plain module. Simple messages are strings with placeholders; only complex messages need its
  selection code, which is a separate export so pages without one never load it.
- **Types**: a generated `src/sinter.messages.d.ts` with nested interfaces
  (`m.inbox.unread(params: { count: number }): string`), inputs typed from the base language's declarations: a
  `plural` input is `number`, a selector input without a function is `string`, a placeholder `string | number`.
  A translation that needs an input the base language does not declare is an error at that file.
- **Diagnostics**: an unsupported construct is reported at its file and message, naming the construct, so a
  project that uses one fails the build instead of rendering the wrong text. SN522 reports the keys that reach
  the end of the chain, once per language.
- **Replacing it**: an app registers its own namespace under `m` (or any name) and does not import the module. A
  test builds such an app and checks that no file of `src/messages/` is in its output.

#### Messages it reads

From the inlang message format, version 4:

```json
{
  "inbox": {
    "title": "Inbox",
    "unread": [{
      "declarations": ["input count", "local countPlural = count: plural"],
      "selectors": ["countPlural"],
      "match": {
        "countPlural=one": "{count} unread message",
        "countPlural=other": "{count} unread messages"
      }
    }]
  },
  "place": [{
    "declarations": ["input n", "local ord = n: plural type=ordinal"],
    "selectors": ["ord"],
    "match": { "ord=one": "{n}st", "ord=two": "{n}nd", "ord=few": "{n}rd", "ord=*": "{n}th" }
  }],
  "code_hint": "Use \\{name\\} for a variable"
}
```

| Construct | In the first version |
| --- | --- |
| nested objects → dotted ids (`inbox.title`) | yes |
| `{name}` placeholders, `\{`, `\}`, `\\` escapes | yes |
| `input x` | yes |
| `local y = x: plural`, with `type=ordinal` | yes, `Intl.PluralRules` in the message's language |
| `local y = x` (an exact value, the first selector before the plural) | yes |
| selectors on inputs without a declaration (`platform=android, userGender=male`) | yes |
| `*` | yes |
| several selectors | yes |
| `pathPattern` as a list, and per-tenant files | yes |
| formatted placeholders: `{x: number …}`, `{x: datetime …}` | later (step 5): onto the core's `number()` and `date()` |
| markup: `{#b}…{/b}`, `{#icon/}` | not planned here (it needs slots, like `<md-doc>`) |
| `icu:pound` and other plugins' functions | not planned |

**Selection**, as MessageFormat 2 selects: each selector gives a value (an input's string, a plural category, an
exact number); a variant matches when each of its keys equals that value or is `*`; among matches, the variant
whose first key differing from the others is exact (not `*`) wins, left to right. An exact number's key wins over
a plural category that also selects it (French `one` selects 0), as the inlang docs say, by being the first
selector.

**The form a page ships**: a simple message is its string, as today. A complex message is a compact array: the
selectors (input name, function, options) and the variants (keys, pattern), patterns as strings with their escapes
resolved to a form the formatter reads without parsing (placeholders as `[name]` parts). A dotted id that is both a
message and a group (`a` and `a.b`) is an error.

## Against other libraries

What an app gets for its texts and languages, after this plan and [axes.md](axes.md), next to the libraries apps
compare it with. From their documentation as of November 2026; checked again before step 3, since these move.

| | sinter after both plans | Paraglide JS | next-intl | Astro i18n |
| --- | --- | --- | --- | --- |
| message format | inlang message format | inlang message format | ICU MessageFormat | none (routing only) |
| plurals, ordinals, select on inputs | yes (step 3) | yes | yes | — |
| nested keys | yes (step 3), as `m.inbox.title()` | yes since format 4.0, as `m["inbox.title"]()`; flat keys recommended | yes | — |
| typed parameters | yes, `sinter check` | yes | yes (with its type augmentation) | — |
| text written into the HTML at build | yes, per language, with no JS for a static page | through the framework's SSR/SSG | through Next's rendering | through Astro's |
| only the messages a page uses ship | yes, per page | yes, per message function (tree-shaken) | per namespace, chosen by the app | — |
| fallback chains | `de-AT → de → en`, and tenant → shared | base locale | per-locale config | per locale, routing |
| formatted placeholders | yes (step 5) | yes | yes | — |
| markup inside a message | not in these plans | yes | yes (rich text) | — |
| prefixed URLs, choosers, `hreflang`, sitemap alternates | yes, built in | URL strategies; `hreflang` by the app | middleware routing; alternates by the app | prefixes; sitemap through an integration |
| a language per domain | static, through the proxy | yes (`urlPatterns`) | yes (`domains`) | with server rendering only |
| translated path segments | not in these plans | yes (`urlPatterns`) | yes (`pathnames`) | no |

What sinter does that these do not: the text is folded into each point's HTML at build time with everything else
that is constant, so a page with nothing live ships no script in any language or tenant, and one that runs carries
only its own messages' text, compiled into its module. What it still lacks after both plans is markup inside a
message and translated path segments.

## Plan

Each step ships on its own and leaves every example app and the e2e pages as they were. It starts after
[axes.md](axes.md)'s step 5 (runtime switching removed), with that proposal's step 0 as its baseline: for the
messages recipe, `examples/multilingual-site`, `e2e/swap-csp` and `test/fixtures/vite-i18n`, the early file, the
page module and each page (bytes, gzip), in `scripts/size.mjs` with budgets.

1. **Content namespaces** (§1). `namespace()` in `@tiaforge-ui/sinter/content`, entries cut per page, folding at
   the point, lookup along the chain, `static` loaders in check and the editor. Tested with a loader that is not
   messages (the legal snippets above). A recipe for an app's own namespace.
   *Started 2026-11-21:* `namespace({ name, format, load, perLocale })` and the compiler's `contentNs` option, which the
   built-in messages now go through too (their output unchanged, byte for byte): entries per language, a call over
   constants folded with the formatter loaded in Node, one over data compiled with its entry and the formatter's
   import, SN206 over the ids, a name clash an error (`test/vite/namespaces.test.ts`). Left in this step: `per`,
   nested ids, calls from app modules (`moduleKeys` generalized), and `static` loaders for `sinter check` and the
   editor.
2. **The messages onto a namespace.** `src/messages/` with `inlang()` for today's format (flat strings), and
   `inlangLocales()`. The compiler's and the Vite plugin's special cases for the messages module go; the
   `messages` option of `sinter()` becomes a shorthand that adds `inlang()` (the one place left that names the
   module, until step 4). The baseline still holds. The test of a build without the module.
3. **The format** (§2): nested keys, complex messages, escapes, lists of files, per-tenant files, the formatter
   (simple and selecting, apart), the types, the diagnostics. Tests per construct, and per language for plurals:
   English (`one`, `other`), Polish (`one`, `few`, `many`), Arabic (six categories), French `one` with an exact
   `0`, English ordinals. New recipes for a plural, for nested keys and for a tenant's texts.
   *Done 2026-11-21* as `src/messages/content.ts` (`inlang()`, `inlangLocales()`, `flatten`, `parseComplex`) and
   `src/messages/format.ts`, on content namespaces (with nested ids and chains in the core), tested per construct
   and per language (`test/messages-format.test.ts`) and in a build (`test/vite/namespaces.test.ts`). Not yet: the
   generated types, `m` in app modules, per-tenant files (`tenantFiles`); the built-in `sinter({ messages })` stays
   until step 4 moves it onto `inlang()`.
4. **The switch.** `sinter({ messages })` is deprecated (a warning, as `openapi` is), and `npx sinter migrate`
   adds the content module export. The starter (`packages/create`) and the examples move. The option is removed
   in the release after (Breaking in the changelog), and with it the last name of the module in the core.
   *Started 2026-11-21:* the build warns when the built-in messages are on; `examples/multilingual-site` and
   `e2e/swap-csp` moved to `inlang()` (the static pages byte for byte the same, the others but asset names; the
   two-language page's budget 12.625 KB while the messages module carries both ways). A formatter's `inline(entry)`
   lets the core compile a plain message in place, so a page whose messages are plain imports no formatter. Not
   yet: `npx sinter migrate` writing the change, and the removal release.
5. **Formatted placeholders.** `{x: number style=percent}` and `{x: datetime …}`, onto the core's formatters, so
   they fold the same way.

## Not in this proposal

- Markup in messages (`{#link to=|/docs|}Read docs{/link}`): it needs slots that render elements, as `<md-doc>`
  does for markdown; a later proposal.
- Translated path segments (`/de/ueber-uns`): routing, not messages.
- Cutting constant resources that are not namespaces by the paths a page reads (§1).
- Other inlang storage plugins (i18next, ICU1): the loader reads the inlang message format only; a project on
  another format converts with inlang's tools.
- A separately published messages package: the module ships in the core package and costs nothing unused.
- Paraglide: dropped (see Status). Using it the way configuration.md describes (a helper namespace and
  `configure({ locale })`) keeps working, and a namespace over it is the replaceable route.

## Open questions

1. **Markup in messages.** Of the gaps left after step 5 (see "Against other libraries"), it is the one an app
   meets most (a link or bold word inside a sentence). Is it the next proposal, before translated paths?
2. **`static` loaders.** A loader that reads a CMS cannot run in the editor. Is the build's snapshot enough there,
   or should the editor show such a namespace's ids as unknown-but-allowed?
