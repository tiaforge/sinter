# Proposal: i18n adapters instead of built-in messages only

Status: proposal, no code yet (2026-11-10).

## Summary

No, not as a plain removal. Going back to "export your library's `m` from the helpers module" keeps the markup syntax, but it loses the first-paint behaviour the custom layer was built for: base-language text in the HTML, the language picked before the first paint, per-page language files, and the no-flash hiding for other languages.

What we can do without losing anything: keep the build pipeline and the early-loading contract, and make the two ends pluggable. A **message source** adapter reads catalogs at build time (inlang is one), and a **message runtime** adapter decides how a message string becomes text (today: `{param}` fill; later ICU plurals). Other frameworks then plug in through these adapters instead of replacing sinter's layer.

Note: paraglide already uses the inlang format, so a paraglide project works with today's built-in layer once the paraglide Vite plugin and `configure({ locale })` are dropped. What it does not get is paraglide's own runtime and its plurals and variants.

## What the built-in messages give today

The layer is about 240 lines (`src/i18n-build.ts`, `src/messages.ts`) plus hooks in `vite.ts`, `project.ts`, the compiler and `early.ts`. Most of its value is in those hooks, not in the lookup.

| Capability | Where | Depends on sinter owning the catalog? |
| --- | --- | --- |
| Base-language text written into the HTML at build (`data-sn-m`) | compiler `baseMessages` | Yes: needs the strings at build time |
| Locale picked in the head before first paint (stored choice, `navigator.languages`, base); sets `<html lang>` | `I18N_PICKER` | Partly: needs the locale list and the file URLs |
| Other languages hidden (space kept) until rendered; shown in base after 3 s | picker + `use(app)` | No, but needs a "rendered" signal |
| One file per page and language, only the keys that page uses (markup, bundle, early file) | `generateBundle`, `moduleKeys` | Yes: needs per-key strings and the static `m.key` guard |
| Early script renders messages whose file arrived during the parse, skips the rest | `observe` (`NOT_YET` trap) | Yes: reads the shared `Symbol.for('sinter.i18n')` state |
| Page module waits for the dictionary, then mounts | compiler `$use(); await $ready()` | Needs a `ready()` |
| `$locale = 'de'` switches without reload, loads that file once, re-renders | `setLocale`, `use()` | Needs async load before re-render |
| Typed `m` (generated `sinter.messages.d.ts`), `SN206` unknown key, `SN208` wrong params | `project.ts`, checker | Needs keys and params |
| Missing translations reported per locale at build | `vite.ts` | Needs all catalogs |
| Zero cost without an inlang project (byte-identical build) | everywhere | — |

## What an external library gets today

The generic path still exists: `export * as m from './paraglide/messages.js'` in the helpers module, and `configure({ locale: { get, set } })`. It keeps markup calls, `SN206` (members are read through `export *` barrels) and the formatters following the locale. If the built-in layer were removed, apps would lose:

1. **First frame in the base language.** Message bindings run only in the early script or page module, so the HTML has no text in that spot.
2. **Locale before first paint.** The app would set it in `src/sinter.early.ts`, but that file is bundled apart from the page bundle: its library state is a copy and must be set again ([first-paint.md](../first-paint.md)).
3. **No-flash for other languages.** Nothing hides base-language text until the right language renders.
4. **Per-page, per-language payload.** Paraglide compiles each message into a function that holds every locale, shipped in the page bundle and the early file. The spec records that paraglide's runtime was "most of the early chunk".
5. **Correct async switching.** `config.locale.set` is synchronous; the runtime marks `$locale` right away. A library that loads its catalog on switch re-renders before the strings arrive.
6. **Early-script coordination.** `observe` cannot tell that a library's catalog is still loading, so it either renders keys or blocks.
7. **Build checks:** missing-translation warnings and the `m[key]` guard.

## Proposal: two adapters around one pipeline

sinter keeps the parts that need control over loading: the picker, the per-page language files, the shared state global, `ready()`, the hiding, `observe`'s trap, the compiler hooks and the checks. Frameworks plug in at the edges.

**1. Message source (build time, Node).** It turns any catalog into what `readMessages` returns today.

```ts
interface MessageSource {
  name: string;
  /** files to watch in dev */
  load(root: string): {
    base: string; locales: string[]; files: Record<string, string>;
    /** key -> source text per locale, in the runtime's syntax */
    dicts: Record<string, Record<string, string>>;
    /** key -> parameter names and types, for the d.ts and SN208 */
    params: Record<string, Record<string, string>>;
    diagnostics: Diagnostic[];
  } | null;
}

sinter({ messages: inlang() })                    // today's default
sinter({ messages: i18nextJson('locales/{locale}/*.json') })
sinter({ messages: lingui('src/locales') })
```

**2. Message runtime (build + browser).** It decides how one message is compiled into the language file and how it is called.

```ts
interface MessageRuntime {
  /** build: one message to JS source, e.g. a template fill or an ICU function */
  compile(key: string, text: string, locale: string): string;
  /** browser module that formats; shared by the early file and page bundle */
  module: string;
}

sinter({ messages: { source: inlang(), runtime: icu() } })  // plurals, select
```

Today's `{param}` fill becomes the default `plain()` runtime. An ICU runtime gives plurals and variants (inlang's own variant format can map to it too), still per key and per page.

**3. Bring your own runtime (escape hatch).** For a library that must keep its own runtime (e.g. an app that shares paraglide code with a server), publish the contract the shared state already follows, so the library can feed it:

| Hook | Today | Made public |
| --- | --- | --- |
| Locale choice before paint | picker | `negotiate(stored, navigatorLanguages, locales)` option, default as today |
| Dictionary arrived | `g.loaded(locale)` | `loaded(locale)` |
| Wait before mount | `ready()` | adapter `ready()` |
| Async switch | `setLocale` then `mark('$locale')` | `config.locale.set` may return a Promise; runtime marks after it resolves |
| Not-yet signal for `observe` | `NOT_YET` trap on the dict | adapter `has(key)` |

This path keeps the picker, hiding and async switching. It gives up base text in HTML and per-page files only if the library cannot list strings at build time.

## Migration, risks, open questions

No breaking change for current apps: `inlang()` + `plain()` is the default, so the `vite-i18n` fixture builds byte for byte the same, and the `vite-app` fixture (no messages) stays free of i18n code.

1. Split `readMessages` behind `MessageSource`; `inlang()` wraps it. Make params typed per source, not only `string | number`.
2. Move `fill` and `languageFile` behind `MessageRuntime`; `plain()` keeps today's output.
3. Make `config.locale.set` awaitable, and mark `$locale` after it resolves.
4. Document the shared-state contract (escape hatch) and add a fixture for it, with paraglide as the test case.
5. Add a second source (i18next JSON) and an ICU runtime to prove the seams. Measure the early file and page sizes against `earlyBudget`.

Risks:

- An ICU runtime adds bytes to the head path; it must stay inside the 10 KB early budget and be per-feature (plural rules only when used).
- Libraries with runtime-only key lookup (`t(variable)`) cannot be cut per page; the build must refuse them, as `m[key]` is refused today.
- More public surface: the shared-state contract becomes API we must version.

Open questions:

- [ ] Which libraries matter first: paraglide, i18next, Lingui, FormatJS?
- [ ] Is keeping the `m.key()` markup syntax a must, or may an adapter bring `t('key')` with a literal-only rule?
- [ ] Should locale negotiation also read the URL (`/de/...`) or a cookie, for apps behind a server?
- [ ] Plurals: ICU MessageFormat, or inlang's variant format, as the first non-plain runtime?
