# Proposal: per-language content and content namespaces, with messages as a package on them

Status: proposed 2026-11-18, not started. It builds on [locale-axis.md](locale-axis.md), which is its
groundwork: the locale in the core (step 1 here) is that proposal's step 1, and if that proposal drops runtime
switching (its decision 4), the runtime parts of §2 and step 2 here fall away. It revisits the decision "i18n source" in
[spec.md](../spec.md#decisions) (2026-11-08: built-in messages from the inlang files, one file per page and
language loaded before the first paint), but keeps every reason given there. Paraglide was considered as the
package's engine and dropped: its message functions carry every language's text, its runtime picks the locale
on its own, and its runtime was most of the early chunk when the built-in messages were decided.

The point is to generalize: messages stop being a feature of their own and become one content loader among
others. The core gains general mechanisms that any loader can use (the locale, per-language content in both
modes, content namespaces cut down to what a page reads), and the messages package is a loader built on them
that adds a syntax and a formatter, nothing the core treats specially.

Decisions proposed:
- **The locale is the core's, messages are a package.** `$locale`, the visitor's language before the first
  paint, `localePrefix`, the choosers, `hreflang`, links that stay in the language, `<html lang>` and the
  formatters stay in the core, configured on their own. Message catalogs, their syntax, their formatter and
  their types move to `@tiaforge-ui/sinter-messages`.
- **Messages are content.** The package is a content loader: it reads the inlang files into a collection per
  language, as `collection({ perLocale: true })` reads a CMS. What the core already does for content (read once
  per build in Node, watched in dev, a constant on the page, written into the HTML at build time, embedded when
  the browser needs it) does it for messages too. The core learns two general things, none of them about
  messages: per-language content without `localePrefix`, and **content namespaces**: a loader's entries called
  as `ns.a.b(args)` through the loader's own formatter, cut down to the entries a page calls.
- **Runtime switching stays**, through the general mechanism: `$locale = 'de'` loads the page's German data for
  every per-language resource, messages included.
- **The package has variants, plurals and dot notation** from the start: the inlang message format's nested
  keys (`m.navigation.contact.email()`), complex messages with `declarations`, `selectors` and `match`
  (plural, ordinal, exact numbers, a choice on an input), and `\{` escapes.
- **Nothing changes for a page** that calls `m.key()` today, beyond one line of config. The output of a page
  whose messages are plain strings is byte for byte what it is today (the same per-page files, the same early
  script), measured in step 0 and checked in every step after it.

## The case

The built-in messages (`src/messages.ts`, `src/i18n-build.ts`, `src/locales-build.ts`, and the special cases
for the module `@tiaforge-ui/sinter/messages` in the compiler and the Vite plugin) do two jobs at once:

1. **They define the locale.** `localePrefix` takes its languages from the inlang project: with
   `messages: false` it throws "the languages come from the built-in messages" (vite.ts:1097–1099). The picker
   that chooses the visitor's language before the first paint is the messages' (`I18N_PICKER`,
   i18n-build.ts:143): the stored choice (`localStorage` key `locale`), then `navigator.languages`, then the base.
2. **They load per-language data before the first paint**, in a way only messages can use: the picker adds the
   page's language file as a module script and hides the elements marked `data-sn-m` (base-language text the
   build wrote) for up to 3 s until the page has rendered them. A `file:` resource with `{$locale}` in its path
   is SN332 without `localePrefix`, and a `perLocale` collection is an error without it: an app that switches
   its language at runtime can translate its UI strings but none of its content.

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
(Polish, Russian and Arabic have three to six plural forms). Dot notation is the second: most existing
translation files are nested.

## Goals

1. `$locale`, `localePrefix` and the early choice of the language work without any messages.
2. `{$locale}` in a `file:` path and `perLocale` collections work in both modes: one build per language
   (`localePrefix`, as today) and one build that switches at runtime.
3. A content namespace ships only the entries a page calls, for any loader: messages, a glossary, feature
   texts, snippets.
4. `@tiaforge-ui/sinter-messages` reads the inlang message format with nested keys, complex messages and escapes,
   types every message, formats them in the browser and at build time, and reports what it cannot do.
5. A page with plain-string messages ships the same bytes as today; a page with a plural message ships the
   plural's selection code and nothing else of the formatter.
6. The core has no code that knows the module `@tiaforge-ui/sinter/messages`, the inlang format, or messages
   at all: every step that serves messages is general, and its tests use a loader that is not messages.

## Design

### 1. The locale in the core

```js
// vite.config.js
sinter({ locales: { base: 'en', all: ['en', 'de', 'pl'] }, localePrefix: true })
```

- `locales` is the core's own option. The picker (stored choice, `navigator.languages`, the base), the `locale`
  cookie of the choosers, `<html lang>` and `$locale = …` read it. Its code moves out of `i18n-build.ts` into
  the early script, unchanged.
- A content loader may supply it (`locales` returned from the messages package, below), so an app keeps one
  list, in `project.inlang/settings.json`. Both given and different is an error naming both lists.
- `$locale` without `locales` is what it is today without messages: the locale of `configure({ locale })`, or
  the page's `<html lang>`.

### 2. Per-language content without `localePrefix`

A resource whose value depends on the language (a `file:` path with `{$locale}`, a `perLocale` collection, a
content namespace over one) is a **per-language constant**:

- The build reads it once per language, as `localePrefix` does today.
- In a `localePrefix` build, nothing changes: each language's page has its own value, folded into the HTML.
- In a build that switches at runtime, the page holds the base language's value (folded into the HTML or
  embedded, as any constant), and the build writes one file per page and language with that language's part of
  every per-language resource the page reads: today's language file, for all such resources at once. The early
  script loads the visitor's file before the page module mounts (today's picker), and `$locale = 'de'` loads
  the German one once.
- Until the file is there, the elements whose bindings read a per-language resource are hidden, keeping their
  space, as `data-sn-m` elements are today (renamed `data-sn-l`, same 3 s limit). Bindings over plain data are
  never hidden.
- The page module waits for the file before it mounts, as `$boot` awaits `$ready()` today
  (compiler/index.ts).

### 3. Content cut down to what the page reads

The compiler knows which paths of a constant resource a page reads: `$r.<name>.<path>` in each binding's
dependencies, plus what app modules read (today's `moduleKeys` for `m.key`, generalized to any content
namespace, below).

- A **content namespace** (below) ships only the entries the page calls, per language. A computed entry
  (`m[k]`) is an error, as for messages today, since the page's data could not be cut. A string literal
  (`m['nav-home']`) is a fixed entry.
- **Other constant resources** keep `fields`, which names fields of each entry. Cutting them by read paths is
  possible with the same analysis but is not in this proposal: a `data-sn-for` over a list reads every entry,
  so the gain is in objects, not lists.

### 4. Content namespaces

A **content namespace** is a collection with two more things: a name its entries are called by, and a formatter
module that turns an entry and its arguments into a value. Entries are keyed by dotted ids. Any content loader
may return one; the core knows nothing about what the entries mean:

```ts
// src/sinter.content.ts
import { namespace } from '@tiaforge-ui/sinter/content';

// an app's own: legal snippets per language, one markdown file each (its slug is its id): legal.imprint()
export const legal = namespace({
  name: 'legal', perLocale: true, format: '/src/legal-format.ts',
  load: ({ files, locale }) => files(`content/legal/${locale}/*.md`),
});
```

`format(entry, args, locale)` is a pure function in the formatter module, so it folds at build time like any
helper. The messages package is one such loader:

```ts
// src/sinter.content.ts
import { inlang } from '@tiaforge-ui/sinter-messages/content';
export const messages = inlang({ project: 'project.inlang', namespace: 'm' });
```

```html
<h1 data-sn-text="m.inbox.title()"></h1>
<p data-sn-text="m.inbox.unread({ count: inbox.unread })"></p>
```

- The compiler resolves `m.inbox.unread(p)` to the entry `inbox.unread` of `messages`, read in the page's
  language, and the call `format(entry, p, $locale)` of the namespace's formatter module. The read is a
  dependency on that entry and `$locale`, so the binding re-renders when the language changes.
- An unknown id is `SN206` with a suggestion over the namespace's ids, in every build, as for messages today.
- The types come from the loader: a namespace's `load` return type gives each entry's type, and its formatter's
  signature the arguments. The messages package generates a declaration file instead, since its arguments
  depend on each message.
- In app modules, `import { m } from '@tiaforge-ui/sinter-messages'` is typed by the generated
  `src/sinter.messages.d.ts`, and its ids are collected per page as `moduleKeys` does now.
- **At build time** the formatter is a pure helper: a call over the build's language and constant
  parameters is folded into the HTML, as helper calls over constants are (static-pages.md). The compiler's
  special case for the messages module (compile.ts:6681–6715) becomes this rule: the namespace's calls depend
  on `$locale`, and fold with the build's language (`localePrefix`) or the base language (runtime switching,
  hidden until the visitor's file is there).
- A namespace without `perLocale` works the same, without the language.
- `sinter check` and the editor need the ids without running loaders. A loader that only reads the project's
  files says so (`static: true`), and check and the editor run it; others keep using the build's snapshot.

### 5. The package

`packages/sinter-messages`, published as `@tiaforge-ui/sinter-messages`:

- `content`: the `inlang()` loader. It reads `project.inlang/settings.json` (`baseLocale`, `locales`,
  `plugin.inlang.messageFormat.pathPattern`, a string or a list merged in order), flattens nested objects to
  dotted ids, and parses each message into a small JSON form (below). It returns a content namespace (`m`) and `locales`.
- `format`: the formatter, a plain module. Simple messages are strings with placeholders; only complex
  messages need its selection code, which is a separate export so pages without one never load it.
- `d.ts` generation: nested interfaces (`m.inbox.unread(params: { count: number }): string`), inputs typed
  from the base language's declarations: a `plural` input is `number`, a selector input without a function is
  `string`, a placeholder `string | number`.
- Diagnostics: an unsupported construct is reported at its file and message, naming the construct, so a
  project that uses one fails the build instead of rendering the wrong text.

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
| `pathPattern` as a list | yes |
| formatted placeholders: `{x: number …}`, `{x: datetime …}` | later (step 6): onto the core's `number()` and `date()` |
| markup: `{#b}…{/b}`, `{#icon/}` | not planned here (it needs slots, like `<md-doc>`) |
| `icu:pound` and other plugins' functions | not planned |

**Selection**, as MessageFormat 2 selects: each selector gives a value (an input's string, a plural category, an
exact number); a variant matches when each of its keys equals that value or is `*`; among matches, the variant
whose first key differing from the others is exact (not `*`) wins, left to right. An exact number's key wins over
a plural category that also selects it (French `one` selects 0), as the inlang docs say, by being the first
selector.

**The form a page ships**: a simple message is its string, as today. A complex message is a compact array:
the selectors (input name, function, options) and the variants (keys, pattern), patterns as strings with their
escapes resolved to a form the formatter reads without parsing (placeholders as `[name]` parts). The per-page,
per-language file holds only the page's ids.

**Fallback**: a message missing in a language falls back to the base language's, reported once per language at
build, as today. A translation whose inputs are not a subset of the base language's is an error at that file.
A dotted id that is both a message and a group (`a` and `a.b`) is an error.

## Plan

Each step ships on its own and leaves every example app and the e2e pages as they were.

0. **Baseline.** Record what the step-1 to step-4 refactors must keep: for the messages recipe, RealWorld and
   a `localePrefix` page, the early file, the page module and each language file (bytes, gzip), and the
   rendered HTML. A test compares them after each step (`test/vite/messages-size.test.ts`, like the size budget
   tests).
1. **`locales` in the core** (design §1; done as [locale-axis.md](locale-axis.md)'s step 1). The picker moves into the early script and reads `sinter({ locales })`,
   or the inlang project when the option is absent (the built-in messages still supply it). `localePrefix`
   works with `messages: false` when `locales` is given. Docs: configuration.md, static-pages.md#languages.
2. **Per-language constants at runtime** (§2). `{$locale}` in `file:` and `perLocale` collections without
   `localePrefix`: the per-page, per-language file, loaded by the picker, `data-sn-l`. The built-in messages
   move onto it: their language file becomes this file. SN332 for `{$locale}` and the `perLocale` error go.
   A recipe: an article in two languages switched at runtime.
3. **Content namespaces** (§3, §4). `namespace()` in `@tiaforge-ui/sinter/content`, entries cut per page,
   folding with the language, `static` loaders in check and the editor. Tested first with a loader that is not
   messages (the legal snippets above), then the built-in messages become a namespace the core creates from
   the inlang project, with a formatter that only knows `{param}`: the compiler's and the Vite plugin's special
   cases for `@tiaforge-ui/sinter/messages` go. The baseline still holds. A recipe for an app's own namespace.
4. **The package** (§5): `@tiaforge-ui/sinter-messages` with the inlang loader (nested keys, complex messages,
   escapes, lists of files), the formatter (simple and selecting, apart), the types, the diagnostics. Tests
   per construct, and per language for plurals: English (`one`, `other`), Polish (`one`, `few`, `many`), Arabic
   (six categories), French `one` with an exact `0`, English ordinals. The messages recipe moves to the package;
   new recipes for a plural and for nested keys.
5. **The switch.** `sinter({ messages })` and `@tiaforge-ui/sinter/messages` are deprecated (warning, as
   `openapi` is); `npx sinter migrate` adds the package, the content module export and the imports. The
   starter (`packages/create`) and the examples move. The built-in namespace is removed in the release after
   (Breaking in the changelog). caley moves in the same release as the deprecation.
6. **Formatted placeholders.** `{x: number style=percent}` and `{x: datetime …}`, onto the core's
   formatters, so they fold and render early the same way.

## Not in this proposal

- Markup in messages (`{#link to=|/docs|}Read docs{/link}`): it needs slots that render elements, as
  `<md-doc>` does for markdown; a later proposal.
- Translated path segments (`/de/ueber-uns`): routing, not messages.
- Cutting constant resources that are not namespaces by the paths a page reads (§3).
- Other inlang storage plugins (i18next, ICU1): the loader reads the inlang message format only; a project on
  another format converts with inlang's tools.
- Paraglide: dropped (see Status). Using it the way configuration.md describes (a helper namespace and
  `configure({ locale })`) keeps working.

## Open questions

1. **Where `locales` is written** when the app has an inlang project: in `settings.json` only (the loader
   supplies it), or in the Vite config too. The proposal allows both and fails on a difference.
2. **Namespaces and helpers in one scope.** A namespace's name may not be a helper namespace's or another
   content namespace's (an error naming both). Should a helper module be able to re-export a content
   namespace under another name, or is the loader's name final?
3. **A complex message's types across languages.** The base language's declarations type the inputs. A
   translation may need an input the base does not (a gendered form in German only); the proposal makes that
   an error. Is a union of all languages' inputs better?
4. **The 3 s limit** on hiding per-language text when its file is slow, now that it covers content too (a long
   article). Keep it, or show the base language's text at once for content and hide only messages?
5. **caley**: it builds with `localePrefix` and built-in messages; step 0's baseline should include one of its
   pages, so the move in step 5 is known to change nothing but the config.
