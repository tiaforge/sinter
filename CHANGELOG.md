# Changelog

Attribute names, function names and diagnostic codes are public API. Before
1.0, renames are allowed but listed here.

How to write an entry (from 0.21.0 on; older sections keep their own form):

- Put it under `## Unreleased`, in one of these subsections, in this order: `### Breaking`, `### Added`,
  `### Changed`, `### Fixed`, `### Performance`. Leave out the ones a release does not need.
- One bullet per change, for someone upgrading: a sentence or two on what changed and what to do, with the
  option, attribute, default or diagnostic code it concerns, and a link to the doc that has the details.
- A Breaking bullet says how to migrate (`npx sinter migrate --write` where it writes the change).
- Implementation details and benchmark figures go in the commit or the pull request. A speed-up or a size
  change is a Performance bullet with its headline number.

## Unreleased

### Added

- `closePopover()` and `closePopover('id')` in handlers: hide the `popover` around the element, or the one with that
  id (a literal naming an element with `popover`, `SN309`), as `closeDialog()` does for dialogs. A same-page link in a
  menu popover closes it: `<a href="#services" data-sn-on-click="closePopover()">` ([docs/actions.md](docs/actions.md)).
- Completion in a `data-sn-for` value: in an empty value, each list in scope with an item name made from it
  (`contact in contacts`, `(contact, i) in contacts`) and the syntax as snippets; after the item, `in` and
  `in contacts`; after `in`, the lists before the other names ([docs/editors.md](docs/editors.md)).

### Changed

- With `images.widths`, the largest width is the widest file: a fluid `<img>` no longer adds a file at the source's
  own width above it, and a sized CSS background's 2x file is at most that width (1x half of it). A 6000 px hero
  with `widths: [480, …, 3840]` ships no 6000 px files. Without `widths` nothing changes
  ([docs/images.md](docs/images.md)).
- A page without an early script links the same stylesheet copy as the pages that defer their fonts, plus the fonts
  file as a plain stylesheet before it, instead of the original stylesheet: every page caches one stylesheet, and the
  fitted fallback fonts apply on that page too ([docs/first-paint.md](docs/first-paint.md#fonts-after-the-load)).

### Fixed

- A stylesheet with `@import 'virtual:…'` (a plugin's CSS, such as temper's `virtual:temper-icons.css`) is read for
  image sizes again: the import is left out and the rest of the stylesheet counts. It used to fail whole (`SN527`),
  and its images fell back to `sizes="auto, 100vw"`. An `SN527` for an `@import` that cannot be opened now names the
  import ([docs/images.md](docs/images.md)).
- Completion in expressions no longer offers the browser's globals (`window`, `HTMLElement`, `onclick`, … about a
  thousand names) or the shadow's `arguments`: only names an expression can use. In a component's `<script>` nothing
  changes ([docs/editors.md](docs/editors.md)).
- The VS Code extension starts the language server again: it failed with `onDidChangeLogLevel is not a function`.

## 0.22.1 (2026-11-24)

### Fixed

- The `sinter` command is executable in the package again: 0.22.0 shipped `dist/cli.js` without its executable bit,
  and `npx sinter` could fail with "Permission denied" where npm kept an earlier link to it (an upgrade from a
  `file:` install). With 0.22.0, `node node_modules/@tiaforge-ui/sinter/dist/cli.js` runs it.
- A `<select data-sn-model>` keeps the option the user picks in Chrome: the browser fires the select's `input` a
  task after it changes the selection, and a render in between set the select back to the model's old value, so the
  pick was lost. A select is now set again after a render only when its model or its options changed since.

## 0.22.0 (2026-11-24)

### Breaking

- **`sinter check` follows `strictNullChecks`.** With a `tsconfig.json` that sets `strict` or `strictNullChecks`, `sinter check` checks page and component expressions with `strictNullChecks` too, so a value that may be `null` is reported where it is used. A state field that starts as `null`, `undefined` or `[]`, at any depth of the state's object and array literals (`{ form: { error: null } }`), accepts what is assigned to it later; give it a JSDoc type to have it checked. A prop given in `data-sn-with` must fit its declared type, so a value that may be `undefined` (`at: last?.tick` for `at: number`) is an error unless the prop is optional; a custom element's properties are checked the same way. Without a tsconfig, nothing changes. An app with a strict tsconfig can get many SN208 errors on upgrading, mostly reads of a value that starts `null`. To migrate: put a dialog's or detail view's content in `<template data-sn-if="draft">` (its expressions are narrowed, and nothing shows while there is no draft), or read with `?.`; add `when="ref"` to a resource loaded by state that may be `null` (its `src`, `call` and `body` are narrowed by it); give a prop a default (`last?.tick ?? 0`) or declare it optional; for state a handler sets before `run('id')`, add `data-sn-when` to the action ([docs/actions.md](docs/actions.md#a-guard-data-sn-when)). ([docs/type-checking.md](docs/type-checking.md#what-the-check-does)).

### Added

- `data-sn-when` on an action (`data-sn-post`, `-put`, `-patch`, `-delete`, `data-sn-call`): the action starts only where it holds, asked as its trigger fires, `run('id')` starts it, or a debounce ends; otherwise nothing happens (no question, optimistic change or request, and a form is not submitted). `sinter check` narrows the call's arguments, the URL, the body, `data-sn-confirm` and `data-sn-optimistic` by it, so state a handler sets before `run('id')`, or a drag before a `drop` trigger, needs no cast under `strictNullChecks` ([docs/actions.md](docs/actions.md#a-guard-data-sn-when)).
- `sinter check` and `sinter lsp` check a single-file component's `<script>` block under the app's `tsconfig.json` (its `extends`, strict options, `lib`, `types` and `paths`), so moving the code into `<name>.ts` changes nothing. This adds a second `tsc` run, only when the app has both a `tsconfig.json` and a block ([docs/type-checking.md](docs/type-checking.md#what-sinter-check-covers-and-what-tsc-does)).
- SN547 `close-component-name` (warning): a tag close to a component's name that is not one, such as `<text-inptu>` beside `text-input.html`, which would otherwise render as an empty custom element. It is an error when the tag has `data-sn-with`; unrelated web components (`<sl-button>`) are not reported. The editor's quick fix renames both tags ([docs/diagnostics.md](docs/diagnostics.md#sn547-close-component-name)).
- Single-file components: a top-level `<script lang="ts">` (or `<script>` for JavaScript) in a component file is its script, as `<name>.ts` beside it is, with its imports resolved from the component's folder. `sinter check`, the build and `sinter lsp` type-check it and report errors at the file's own lines (SN208); two top-level scripts, a block and a script file, or a `lang` other than `ts` are SN312 ([docs/islands.md](docs/islands.md#single-file-components)).
- Editors: `sinter lsp` and the VS Code extension give completion, hover, go to definition and type errors inside a single-file component's `<script lang="ts">`, typed by the component's props, events, refs and state. The extension highlights the block as TypeScript and turns off VS Code's `html.validate.scripts` ([docs/editors.md](docs/editors.md)).
- A component's styles can be a file of their own, `<name>.css` beside its HTML, scoped as its `<style>` is. A `<style>` and a `.css` file both is SN312; a head component with one is SN320 ([docs/components.md](docs/components.md#styles)).
- A component can live in a folder of its own, `src/components/task-ring/task-ring.html`, with its script, early renderer and modules beside it; a library's `components/` and `components/internal/` take the same form. New error SN349 (`component-location`): a component in both places, another HTML file in a component's folder, or HTML in a folder not named after a component in it ([docs/components.md](docs/components.md#where-its-files-go)).
- Early renderers: `<name>.early.ts` beside a component's script, whose default export `(root, props)` fills the root in the early script, before the first paint, where the use's props are known early (constants, the URL, embedded data). The instance sees `this.early`. New warning SN543 (`filled-at-mount`) for a component with a script and an empty root, used where its props are known early, that has none; not for a root that is `hidden`, which shows nothing, nor for a script that writes no content (no DOM-writing call, its root passed to no function) ([docs/components.md](docs/components.md#early-renderers)).
- `$build` and `$slots`, for a component to choose how a use renders: `$slots` names the slots the use fills; `$build` is `true` at build time and `undefined` in the browser, and may only decide a `data-sn-if` (SN201 elsewhere) ([docs/components.md](docs/components.md#choosing-how-it-renders-per-use-build-and-slots)).
- `attrAllowed(el, name, value)` and `styleAllowed(value)` from `@tiaforge-ui/sinter`: the checks `data-sn-attr` and `data-sn-style` apply (allowed URL schemes, the app's `urlSchemes` included; no style value that loads a URL), for a component script that builds elements itself ([docs/islands.md](docs/islands.md)).
- `sinter({ compileHints: true })` (default `false`): each page module starts with V8's `//# allFunctionsCalledOnLoad`, so Chromium compiles it as the page loads. Worth it where the first render runs much of the code at once ([docs/configuration.md](docs/configuration.md#checks)).
- Accessibility warnings: SN544 (`click-without-keyboard`), a click handler or click-started action on an element that takes no focus and has no `role` or `tabindex`; SN545 (`late-live-region`), a live region that is the top of an `if`, `else` or `for` template, so it is not announced; SN546 (`image-alt`), an `<img>` without `alt`, `aria-label`, `aria-labelledby`, a hiding role or `aria-hidden`. Strict mode makes them errors ([docs/diagnostics.md](docs/diagnostics.md)).
- `@tiaforge-ui/sinter-markdown`: `<md-view>`, a script renderer `<md-doc>` uses for a document from an API, several times faster than the components; it has an early renderer, so an embedded document is in the first paint. A use that fills a slot, a `file:` document, or `templates: true` renders through the components as before; pass `templates: true` for a live preview that should update in place. `build(doc, onRefused)` reports a URL attribute the check left out.

### Changed

- A production build checks its helper calls again (SN534) in a thread of its own beside the build instead of after the pages, and waits for it once Vite has processed the pages. A build this check fails now leaves the output folder (`dist/`) empty, where before it was left as it was; the error is the same, but another error found later in the build (a type error, a page's link check) is now reported before it ([docs/diagnostics.md](docs/diagnostics.md#sn534-helper-not-folded)).
- The Speculation Rules in every page name the site's pages with one pattern once a rule has 16 plain paths or more (a site with a file per page), instead of listing two patterns a page; the pattern matches exactly the paths the list did, so the same links are prefetched. At 1,000 page files a page goes from 58 kB (6.6 kB gzip) to 11.4 kB (1.3 kB), and the build is 4 s faster; the rules' CSP hash changes once, as with any change to the pages ([docs/navigation.md](docs/navigation.md#speculation-rules)).
- The starter's `npm run check` runs `tsc --noEmit` before `sinter check`, which never reports errors in the app's own modules ([docs/type-checking.md](docs/type-checking.md#what-sinter-check-covers-and-what-tsc-does)).
- Web fonts load after the first paint, their text painted meanwhile in a fallback fitted to the font's metrics (`Inter Fallback`, from local Arial or Times New Roman). In builds, on pages with an early script, for text fonts whose `@font-face` has `font-display: swap`, or none (which becomes `swap`); icon fonts, faces in `fonts.preload` and faces with `block`, `fallback` or `optional` stay render-blocking. The deferred faces move to `assets/fonts-<hash>.css`, linked after `load` (in `<noscript data-sn-fonts>` without JavaScript), and at once for a reader who has had them (`localStorage` key `sn-fonts`); no inline script or style. There is no option, and dev is unchanged ([docs/first-paint.md](docs/first-paint.md#fonts-after-the-load)).
- `sinter({ embed: true })` embeds the signed-out answer of an operation whose spec makes the token optional (`security: [{}, { Token: [] }]`) on an API with a `token`; a visitor with a token stored gets it requested early with the token. Request middleware no longer keeps such an operation from being embedded ([docs/apis.md](docs/apis.md#a-token)).
- `data-sn-transition` morphs nothing when the visitor prefers reduced motion (`prefers-reduced-motion: reduce`); `render({ reducedMotion: true })` tests it ([docs/navigation.md](docs/navigation.md#page-transitions)).
- Dev page modules (the dev server, `render()` from `@tiaforge-ui/sinter/testing`) no longer keep empty `0` slots in their function table for the functions of rows the build writes into the page, so function indices in dev modules differ from before. Nothing to do: nothing reads them but the module itself.
- When a list row goes while the focus is in it (a delete, `remove()`, a server's event), the focus moves to the same control in the row now in its place, else that row's first focusable element, else the list's parent (given `tabindex="-1"`), instead of `<body>` ([docs/actions.md](docs/actions.md#optimistic-updates)).
- A build embeds only what the browser's code reads of a `file:` value, a collection or a page's entry. A read down to a number, a boolean, `null` or a string of up to 120 characters (`{post.slug}` in a live resource's URL) is written into the page module as a literal, and a value only read that way is not embedded at all; an object read further is embedded with only the fields read, at each depth. On the benchmark's blog post with live comments the page goes from 20,345 to 11,811 bytes: it no longer ships the post's markdown source and file path a second time. A value that may be read whole (passed to a helper, spread, held in state, sent as a body, read by a computed key) and lists stay whole, and dev embeds everything as before. Nothing to do: a field the code does not read cannot be missed, since a read the build cannot follow keeps the whole value; to embed fields by hand, `fields="…"` still applies ([docs/resources.md](docs/resources.md#files)).

### Fixed

- A component library in `sinter({ lazy })` builds with its scripted components on a page: their scripts load with the library when their component first renders, as a script that imports a lazy package does. Before, a script that imports none (`<mail-width>` of `@tiavision/sinter-mail`) was in the page bundle, and with it the library: SN325 ([docs/lazy.md](docs/lazy.md#component-scripts)).
- An else-if chain (`<template data-sn-else data-sn-if="q">`, and a plain `data-sn-else` after it) shows one branch at most. Before, each else-if was a `data-sn-if` of its own and the final `data-sn-else` followed only the branch before it: in a loop's rows, the matching branch and the final else both rendered, and at the page's level a chain over constants was SN102. An else-if after nothing is SN102. `sinter check` narrows each branch, and an else-if's condition, by the branches before it ([docs/attributes.md](docs/attributes.md)).
- A stylesheet or asset of a package in `sinter({ lazy })` (`import '@tiavision/sinter-mail/mail.css'`) is no longer SN324 ("runs the package for its side effects"), nor counts as the module reaching the package: it loads none of the package's code ([docs/lazy.md](docs/lazy.md)).
- A component chosen with `<sn-component use>` whose `data-sn-with` reads state that a handler writes now renders in the browser and updates when the state changes. The build expanded it as a constant from the state's initial value: its text, attributes and images (a `<picture>` with `images` on) were written into the page and never changed. The component used by its tag was not affected ([docs/static-pages.md](docs/static-pages.md)).
- A number given as a prop and read with a member in the component (`n.toFixed(1)` with `data-sn-with="{ n: 1 }"`, or `$slot.n.toFixed()` from a `<slot data-sn-with>`) no longer fails the build with `Invalid characters after number`: the compiled code read `1.toFixed(1)`. Nothing else in the compiled code changes ([docs/components.md](docs/components.md)).
- `sinter check` reports the type errors (SN208) of every page when one expression of the app does not parse (SN401). It printed the parse error and no type error at all, on any page ([docs/type-checking.md](docs/type-checking.md)).
- `sinter check` and the build's type check report a type error (SN208) in a component used inside itself once per use, as for any component. It came twice on each page, the second time `(included from <page>:1)`, and an error in a page's fill of a tree slot such a component places came twice too ([docs/type-checking.md](docs/type-checking.md)).
- The build's type check counts errors and warnings apart: `sinter check: 49 type error(s), 1 warning(s)`, where it said `50 type error(s)`. A build whose check finds only warnings (SN538 `unreachable-candidate`) now prints them and passes, as `typecheck` is documented to fail on type errors; with `strict`, they fail it as the pages' warnings do ([docs/type-checking.md](docs/type-checking.md)).
- An error in markup the build decides away (inside `<template data-sn-if="false">`, or the `data-sn-else` of a branch that is always true), such as SN201 for an unknown name, is reported at its place and fails the build. It was dropped silently, while it still kept the page's loops over constants from being unrolled, so the page shipped JavaScript it did not need ([docs/static-pages.md](docs/static-pages.md)).
- A `file:` resource, a collection or a page's entry read by code in the browser read `null` in a build since 0.21.0: the embedded value was never stored, so a live resource whose URL read the entry (`/api/comments?post={post.slug}`) was not requested. It is stored again ([docs/resources.md](docs/resources.md#files)).
- A component with scoped styles used in a list the build unrolls (a `data-sn-for` over constants, such as a `file:` resource or a literal) now has its styles on every row. Only its use outside the loop had `data-sn-c` on its root, so its `<style>` and `<name>.css` rules did not apply to the rows ([docs/components.md](docs/components.md#styles)).
- `sinter check` and the editor compile each page with the options `vite build` uses: its URLs with `site`, its language's URLs with `localePrefix`, and the content namespaces with their formatters. A valid app no longer fails the check with SN323 for `$canonical` when `site` is set, or with SN322 on `static` pages for `m.key()`, `localeUrl()` and `$locale`, which the build writes into the HTML. The editor no longer reports `Cannot find name 'm'` (TS2304) for messages.
- `render()` from `@tiaforge-ui/sinter/testing` renders pages with a single-file component: `scripts: { 'task-ring': TaskRing }` gives the class that stands for its `<script>` block. A component with a script but no class in `scripts` fails with an error naming it, instead of a `TypeError` in the runtime, and a `render()` that throws while mounting no longer makes later ones fail with `sinter: already mounted` ([docs/testing.md](docs/testing.md#component-scripts)).
- Component HTML nested deeper in a components folder (`src/components/forms/text-input/text-input.html`, `task-ring/parts/ring-label.html`) is SN349 with a hint where to move it, instead of being silently ignored. This applies to libraries' `components/` and `components/internal/` too.
- A component script that throws in `connected()`, `propsChanged()` or `disconnected()` is reported with `console.error` in production builds too; it was dropped silently.
- A component whose root is an if/else chain passes its tag's attributes (an `id`) to a branch that is another component's tag.
- Back and Forward across swaps restore a scroll position the page reaches only once its data is in (a long list); it landed near the top.
- `data-sn-transition` morphs on a swap to a page whose element renders from its first response: the old page now stays on screen until the element is there, the page's responses are in, or 500 ms pass. A page load is unchanged ([docs/navigation.md](docs/navigation.md#page-transitions)).

### Performance

- A built page with nothing for Vite's HTML handling to do (no module script, stylesheet, `<style>`, image or other asset URL, `%ENV%` value) is not parsed by Vite again, with the same output: 0.1 s off 100 static posts, 0.3 s off 400, 0.6 s off 1,000. Only in an app whose other plugins have no `transformIndexHtml` hook ([docs/configuration.md](docs/configuration.md#vite-plugin-options)).
- The check of the helper calls (SN534) runs beside the build, so it no longer adds to it: 0.14 s off a build of 100 posts and 0.35 s off 400 (it uses about 80 to 110 MB more memory while it runs).
- A build keeps what the check of build-time helpers reads of each module in `node_modules/.cache/sinter/fold`, by the module's text, and the next build reads it there instead of parsing the helpers' modules again: about 0.1 s off every build's start with sinter-markdown's helpers, 0.2 s with sinter-mail's, with the same verdicts and output. Delete the folder to clear it ([docs/static-pages.md](docs/static-pages.md#helpers-and-files-at-build-time)).
- A build of a site with a page file per post no longer tests every page's module against every moved page for SN521, which grew with the square of the pages (1.2 s at 1,000 pages), and every build scans the app's modules for the stylesheets they import once instead of once per page (0.3 ms a page), with the same output.
- A build no longer compiles a description of every page that is a file of its own before compiling it: what other pages read early (paths, `data-sn-prefetch="off"`) is read without a walk, and what a page can have requested ahead comes from its own compile, about 2.5 ms a page with the same output (100 posts, a page file each: 0.1 to 0.2 s; sinter-mail's 16 pages about 1 s). Builds with `swap`, `embed` or `prerender: 'auto'` describe pages as before.
- Pages whose early scripts differ only in a value (each post requesting its own comments) share one nested build of the script instead of one each, with the same output: the benchmark blog's live posts run 3 nested builds instead of 101 (or 401), about 1 s off the build per 100 live pages.
- Builds with a component library that dispatches on node type in each component (`<sn-component use="{ … }[node.type]">`) are back to 0.20's speed or faster, with the same output: sinter-mail (65 components) on 12 pages in ~2.6 s, against ~3.3 s on 0.20.0 and ~3.7 s on 0.21.0.
- Builds of pages over data the build knows (a markdown post through sinter-markdown's components, a list over a `file:` source) render that content at build time from the compiled templates instead of compiling every component instance a second time, and do less per page besides (each component file read once per build, a page's first pass stopping at its decisions): the benchmark blog's 100 posts build in about 3 s instead of 11.6 s (400 posts: 9 s instead of 45 s; a page file per post: 4.4 s instead of 14.4 s), with the same output.
- Pages whose early script has the same source (on a blog, every post's) share one nested build of it instead of one each: a build of 100 posts with a live section is 1.6 s faster (8.3 s at 400 posts), with the same output. The early scripts that differ go through one Vite builder instead of one `vite build` each: 0.45 s less per 100 such pages.
- A build no longer gzips every page's scripts for size lines that `logLevel: 'warn'` does not print, and gzips a script that several pages share once: 1.4 ms less per page with a page module (0.7 s at 400 such pages).
- A build with a page per entry (`data-sn-for` on `<html>`) lists the entries from a description of the template instead of compiling it: about 150 ms off every such build.
- A build no longer remakes its list of pages for every page it compiles, which grew with the square of the pages: a build of 400 pages, each its own file, is 4 s faster outside the compiler (0.5 s at 100).
- The type check of a build (`typecheck`, on with TypeScript installed) and `sinter check` give TypeScript what pages repeat once, such as a component's markup, instead of once per page and per use, and report the same diagnostics; and the pages share their components' compiled definitions under the check, as they did without it. On a loaded 4-core machine, 100 posts, each its own page file, build in 14 s instead of 30 s, and sinter-mail's 12 pages from an API in 9 s instead of 39 s (without TypeScript: 6.5 s and 4 s) ([docs/type-checking.md](docs/type-checking.md)).

## 0.21.0 (2026-11-21)

Upgrading from 0.20: run `npx sinter migrate` to see what changes, then `npx sinter migrate --write`. It applies every rename below (each old name is a build error that names its replacement) and moves the built-in messages (`sinter({ messages })`, removed in this release without a deprecation release) into the content module as `inlang()`.

### Breaking

- The built-in messages are removed: `sinter({ messages })` is SN348 (`removed-option`), and `src/sinter.messages.d.ts` is gone. Export them from the content module instead, `export const messages = inlang()` and `export const locales = languages(({ root }) => inlangLocales('project.inlang', root))` (`@tiaforge-ui/sinter/messages/content`); `npx sinter migrate --write` writes both. A build with `project.inlang` that no namespace reads warns, and `localePrefix` without `languages()` fails. The messages a page calls are in `<script type="application/json" data-sn-ns="m">` (was `data-sn-messages`). `render()` and `firstPaint()` keep their `messages` option ([docs/messages.md](docs/messages.md)).
- A page has one language, chosen at build: with `sinter({ localePrefix: true })` each page is built once per language, without it in the base language. `$locale` cannot be assigned (SN203). Gone: choosing the language in the browser (the stored choice, `navigator.languages`), the per-page language files, the hidden base-language text (`data-sn-m`), and `setLocale()`, `onLocale()`, `ready()` and `use()` from `@tiaforge-ui/sinter/messages`. `render()` and `firstPaint()` with `messages` render in `locale` or the base (`locale` is no longer read from `storage`). To switch language in place, use another i18n library through a helper namespace and `configure({ locale })` ([docs/messages.md](docs/messages.md), [docs/static-pages.md](docs/static-pages.md#languages)).
- A smaller vocabulary, one word per concept ([docs/proposals/vocabulary.md](docs/proposals/vocabulary.md)). Each old name is a build error naming its replacement (SN101 for an attribute or element, SN201 for a function, SN401 for a value; an option fails the build) until 1.0, when it becomes an unknown name. `npx sinter migrate --write` writes every rename in pages, components and layouts, and the editor's quick fix writes one:

  | Was | Now |
  | --- | --- |
  | `patch()`, `<sn-event op="patch">`, `Resource.patch()`, a change message's `op: 'patch'` | `merge()`, `op="merge"`, `Resource.merge()`, `op: 'merge'` |
  | `refetch`: `op="refetch"`, `Resource.refetch()`, `op: 'refetch'` | `refresh`: `op="refresh"`, `Resource.refresh()`, `op: 'refresh'` |
  | `showModal()`, `close()` | `openDialog()`, `closeDialog()` (`closeDialog()` closes the nearest dialog, `closeDialog(id)` that one) |
  | `clearPersisted()` | `clearStored()`, which also clears the page-load cache and next-page data |
  | `datetime(v)`, `time(v)` | `date(v, 'medium', 'short')`, `date(v, null, 'short')` |
  | `data-sn-listbox` | `data-sn-options`, now also for menus, toolbars and selectable lists ([docs/actions.md](docs/actions.md#lists-you-move-through-with-the-keys)) |
  | `data-sn-apply="off"` | `data-sn-write-through="off"` |
  | `data-sn-pages` | `data-sn-for` on `<html>` or a layout's tag |
  | `data-sn-component`, `data-sn-head`, `data-sn-layout` | `data-sn-props`; the kind comes from the file: in `src/layouts/` a layout, only head elements a head component, else a body component (on a page's `<html>`: SN318) |
  | `data-sn-prop` | `data-sn-with` |
  | `data-sn-data` | `data-sn-resource` |
  | `data-sn-on-navigate`; the `dismiss` event of `data-sn-options` | `data-sn-on-sn-navigate`; `sn-dismiss` (names starting `sn-` are reserved, SN209) |
  | `<sn-resource items>`; `items` in `sinter({ apis })` and `render({ apis })` | `select` |
  | `<sn-resource each="a in accounts">` | `for="a in accounts"` |
  | `<sn-event item>`, `<sn-event set>` | `value` |
  | `paginate="keyset"` with `page-size`, `cursor`, `page-model`, `size-param`, `page-param`, `offset-param`, `direction-param`, `direction-values` | one object: `paginate="{ keyset: { before: $item.id }, size: 20 }"` (or `append`, or `numbered: true`), with `size`, `model`, `params: { size, page, offset, direction }`, `directions`; `offset-param` on a keyset list is `jump: true`, and `numbered: 'offset'` sends the items to skip ([docs/pagination.md](docs/pagination.md#the-object)) |
  | an `<sn-event>`'s payload field, bare (`person`); a cursor's item, bare (`id`) | `$event.person`; `$item.id` |
  | `sinter({ speculation })` | `prefetch: { html }`: `true` (default; was `'prefetch'`), `false`, `{ prerender: true, delivery: 'header' }` (was `{ mode, delivery }` and `'prerender'`) |
  | `sinter({ earlyBudget })` | `firstPaint: { budget }` |
  | `sinter({ components })` | `libraries` |
  | `sinter({ defaultApi: 'main' })`, `render({ defaultApi })` | `apis: { main: { default: true } }` |
  | `sinter({ fonts: { inline } })` | `fonts: { bundle }`; off is `fonts: false`, which also turns off `preload` (`fonts: { bundle: false, preload }` keeps the links and preloads) |
  | `sinter({ complexity: { level: 'off' } })` | `complexity: false` |
  | `render({ minify })`, `render({ remoteImages })` | `minifyHtml`, `images: { remote }` |
  | `@tiaforge-ui/sinter/<feature>`, `@tiaforge-ui/sinter/apply`, `/runtime/each` | `@tiaforge-ui/sinter/runtime/<feature>`, `/runtime/write-through`, `/runtime/for` (only pages that import feature modules by hand notice) |
  | `SlotRequest`, `SlotData`, `SlotResolver` (server layers, TypeScript, Rust, C#) | `PlaceholderRequest`, `PlaceholderData`, `PlaceholderResolver` |

- Diagnostic codes: SN302 (a resource declared twice) is SN209 `name-conflict`; SN311 is SN309 `unknown-element-id`, SN319 is SN318 `invalid-layout`, SN338 is SN337 `invalid-library` and SN341 is SN340 `invalid-entry-page`; SN316 is gone. Renamed: SN345 `url-param-entry`, SN505 `undeclared-query-in-spec` (was `unknown-query-param`), SN517 `missing-resource-key` (was `unkeyed-list`), SN523 `first-paint-budget` (was `early-budget`) ([docs/diagnostics.md](docs/diagnostics.md)).
- `prefetch: false` now turns off the Speculation Rules too; `prefetch: { data: false }` turns off only the next page's data, as `prefetch: false` did ([docs/navigation.md](docs/navigation.md#next-page-data)).
- Removed `data-sn-get`: data a GET loads is an `<sn-resource>`. For a load a click starts, set the state the resource's `when` reads (recipe: click to load), or use `data-sn-call` ([docs/resources.md](docs/resources.md)).
- Removed `<sn-event fallback>` (SN101): write two events of the same name, `op="upsert" value="person" when="person"` and `op="refresh" when="!person"` (recipe: partial events) ([docs/sync.md](docs/sync.md#sn-event-attributes)).
- Removed the store function `reset()`: a form clears by clearing its state (`data-sn-then="body = ''"`) ([docs/actions.md](docs/actions.md#clearing-a-form)).
- Removed `$meta.<name>.pending` (SN303), `Resource.meta.pending` and the `Meta` type's `pending`: the element whose request is in flight has `aria-busy`.
- Removed `sinter({ helpers, actions, config, early, types })` and `content: '<path>'`: the modules have fixed names, `src/sinter.helpers.ts` and so on (`.js` too); a component library's are in `fixtures/` beside its fixture pages. The options fail naming the file ([docs/configuration.md](docs/configuration.md#project-files)).
- Removed the `credentials()` middleware: fixed request settings belong to the API, `sinter({ apis: { site: { credentials, headers } } })`, which also keeps early requests. A config module that calls it fails naming the option ([docs/apis.md](docs/apis.md)).
- Removed `configure({ env })` (the testing module sets the clock, storage and fetch); `configure({ apis })` fails naming `sinter({ apis })`.
- Removed `sinter({ checkCycles })` and `--check-cycles`: SN509 (`run-cycle`) is reported on every check. Keep a deliberate cycle a warning with `strict: { allow: { SN509: 'why' } }` ([docs/strict.md](docs/strict.md#keeping-a-code-a-warning)).
- Removed `@tiaforge-ui/sinter/components` (a component's script extends its base from its own HTML, `./task-ring.html`); an app module that imports it fails the build. The main entry no longer exports `mount()`, `$origins`, `$apis`, `$k`, `parsed`, `rendered` or the types `MountOptions`, `Feature`, `Intent`, `Navigator`, `IR` and `Env`, and its `Resource` type lists only the members an app uses.
- The migration errors for `<sn-include>` (0.14) and `start-page` are gone: both are unknown names (SN101).
- `refresh()`, `upsert()`, `page()` and `$meta[…]` take the resource, not its name: `refresh(people)`, `page(messages, 'next')`, `$meta[shown]`. A name as a string is SN301 naming the form.
- `$meta.<name>.loadedAt` is a `Date`, as `$now` is (was milliseconds).
- `data-sn-debounce` delays an action's trigger only. On an element without a method it is SN102; use `data-sn-debounce-<event>` for each handler (`data-sn-debounce-input="250"`).
- `params.offset` on a list that sends no items to skip (`numbered: true`, keyset without `jump`, append) is SN401; naming it no longer switches the list to offsets.
- A helper named like a store function (`merge`) is SN201 where it is called: the store function always won, so the helper was unreachable.
- Options take known keys only: a typo in `sinter({ … })`, `fonts`, `images`, `prefetch`, `firstPaint` or `configure({ … })` fails naming the mistake. `strict.allow` and `--allow` take only warnings strict mode fails on; `data-sn-wait` takes `off` only, `data-sn-encoding` takes `form` and `<sn-resource method>` takes `POST`.
- `sinter({ complexity })` takes `{ level: 'error' }` or `false`; its six limits are fixed, and their keys fail naming the change ([docs/expressions.md](docs/expressions.md#complexity-limits-sn507)).
- `vite build` type-checks by default when the project has TypeScript, including the component libraries' types; `typecheck: false` turns it off ([docs/configuration.md](docs/configuration.md#checks)).

### Added

- `inlang()` from `@tiaforge-ui/sinter/messages/content`: an inlang project's messages as a content namespace, with nested keys (`m.inbox.title()`), plurals and ordinals in each language's categories, selectors, escapes, several files, fallback chains and formatted placeholders (`{rate: number style=percent}`); the formatter, `@tiaforge-ui/sinter/messages/format`, loads only for a plural or a formatted placeholder. App code's `m` is typed by the generated `sinter.namespaces.d.ts` next to the content module. `inlang({ per: [tenants, locales], tenantFiles })` reads a tenant's own message files over the shared ones ([docs/messages.md](docs/messages.md)).
- Content namespaces: `namespace({ name, format, load })` in the content module is a collection whose entries a page calls by id (`legal.imprint({ shop })`) through the app's formatter module (`format(entry, args, locale)`); calls over constants are written into the HTML. `namespace({ per })` loads one per axis, and a namespace loaded per language takes a missing entry from its language's chain. Every collection's `load` gets the project's `root` ([docs/resources.md](docs/resources.md#content-namespaces)).
- `languages()` in the content module (`@tiaforge-ui/sinter/content`) declares the site's languages: `languages({ base, list })`, or an inlang project's with `languages(({ root }) => inlangLocales('project.inlang', root))`. It takes `paths` (`{ 'de-AT': 'at' }`: `/at/about/`), `codes` (`{ no: ['nb', 'nn'] }`), `domains` (`{ fr: 'https://example.fr' }`) and `fallbacks` (`{ 'de-CH': ['de-AT', 'de'] }`). The page's language is the locale of `date()` and `number()` ([docs/static-pages.md](docs/static-pages.md#languages)).
- Fallback chains: a message missing in a language comes from its tag less its subtags, then the base (`de-AT → de → en`); SN522 reports only keys missing in the base. Choosing a visitor's language drops subtags too (`zh-Hant-TW` reaches `zh-Hant`) and goes the other way (`de` reaches `de-DE`), the same in the chooser pages, `@tiaforge-ui/sinter/server`, sinter-axum and Sinter.AspNetCore ([docs/static-pages.md](docs/static-pages.md#languages)).
- Axes: `data-sn-for` on `<html>` (or a layout's) takes several lists, `tenant in tenants; post in posts`, and builds the page once per entry of each, under its key (`/acme/about/`; with `localePrefix`, `/de/acme/about/`); on a layout, every page that uses it. Without a pattern to fill it is such an axis, where it was SN340. Links stay in the page's tenant, and a link to a tenants-only page from outside them fails the build. `axisUrl(tenants, key)` is this page at another tenant, as `localeUrl()` is at another language ([docs/static-pages.md](docs/static-pages.md#a-site-per-tenant-axes)).
- `collection({ key, per: [tenants], load })` loads a collection per entry of an axis (and per language with `per: [tenants, locales]`), and each page reads its own. An axis entry with an `origin` is a tenant on its own domain, written under `dist/<key>/` with its own URLs, sitemap and chooser ([docs/static-pages.md](docs/static-pages.md#a-site-per-tenant-axes)).
- The server layers (`@tiaforge-ui/sinter/server`, sinter-axum, Sinter.AspNetCore) serve tenants and languages on their own domains from their folders, through the embed manifest's `origins`, and choose and redirect with `paths` and `codes` ([docs/server.md](docs/server.md)).
- `data-sn-href`: a link's URL as a template, `<a data-sn-href="/profile/{a.author.username}">`, each value URL-encoded; a whole query value that is `null` or `[]` leaves its parameter out. It must start with a literal path, origin, `?` or `#` (SN207), and is a bound `href` everywhere (next-page data, swaps, first paint) ([docs/navigation.md](docs/navigation.md#links)).
- Empty states: a `<template data-sn-else>` right after a `<template data-sn-for>` renders while the list is empty and the resources it comes from have loaded with no error, so it never shows beside "Loading…"; an else-if there is SN102 ([docs/resources.md](docs/resources.md#loading-empty-error)).
- `more` in `paginate`: the path in the response that says whether there are more items (`more: 'has_more'`); without it a list without `total` that ended on a full page offered an empty next page. It can be set once per API, `apis: { main: { paginate: { more } } }`, and is checked against the OpenAPI response (SN308) ([docs/pagination.md](docs/pagination.md#whether-there-are-more)).
- A token declared on the API, `sinter({ apis: { main: { token: { storage: 'local:jwt', scheme, signIn, from } } } })`: sent to that API's requests only, so its resources are requested early again whatever middleware the config has. A response of an operation in `from` stores it, a 401 clears it, and an unhandled 401 goes to `signIn`. Signed out, a GET that needs it is not sent and its resource is loaded empty at mount, so `$meta.user.loadedAt && !user` is signed out in the first frame. The header and scheme come from the spec's `securitySchemes`. New store function `signOut()` ([docs/apis.md](docs/apis.md#a-token)).
- `data-sn-signed-in` on a page's `<html>` (or its layout's tag), empty or a condition over `$url`: with no token stored, the visitor goes to the API's `signIn` before anything paints. SN347 (`session`) refuses it without one API with a token and `signIn`, on the sign-in page, or with a condition over more than `$url`. A convenience, not security ([docs/apis.md](docs/apis.md#pages-that-need-a-session)).
- Back and Forward show a page as it was left when the back/forward cache does not have it: every resource but `for`, `call` and POST ones shows the data it had, then revalidates; `cache` is no longer needed for that. `render(html, { traverse: true })` tests it ([docs/resources.md](docs/resources.md#back-and-forward)).
- Next-page data covers paginated lists whose `src`, `when` and page read only `$url`, constants and helpers ([docs/navigation.md](docs/navigation.md#next-page-data)).
- `sinter({ prefetch: { html: { prerender: 'auto' } } })`: the build prerenders the pages that only read as they load and prefetches the HTML of the rest, and prints which and why. `true` stays the default ([docs/navigation.md](docs/navigation.md#prerendering-chosen-per-page)).
- `data-sn-retry` on `data-sn-call`: each request the function sends with `ctx.request` follows the policy with its own idempotency key, and the function runs once; a request's own `retry` wins (it was SN102) ([docs/retry.md](docs/retry.md)).
- `data-sn-model-debounce` delays a field's model write (`data-sn-model-debounce="200"`) while the field shows each keystroke: a resource over it loads once after the pause, and a model on `$url` writes one history entry. Enter or leaving the field writes at once ([docs/actions.md](docs/actions.md#model)).
- A component without props needs no `data-sn-props=""`: the file's one top-level `<template>` is its declaration. `data-sn-if`, `data-sn-else`, `data-sn-for` or `data-sn-text` on that template, or two top-level templates without `data-sn-props`, are SN312 ([docs/components.md](docs/components.md#the-file)).
- One duration grammar for `cache`, `refresh` and the debounces: a number and `ms`, `s`, `m`, `h` or `d` (`refresh="1d"`, `data-sn-debounce="0.3s"`); the debounces still take a bare number of milliseconds.
- Warning SN542 (`unkeyed-list-write`): `upsert`, `merge` or `remove` of a resource without `key` that is typed as a list, which changes the whole list rather than one item; dev builds warn at run time too.
- `sinter check` and `sinter migrate` take `--root=dir` as `sinter render` does.
- `llms-full.txt` has a section per guide, `npx sinter docs <topic>` prints one (`pagination`, `strict-mode`, `live-updates`, …), and `llms.txt` has an index line for each.
- Diagnostics: every pure rename says "`X` is renamed to `Y`", so the editor's quick fix writes it; `data-sn-marked`, `data-sn-error` and `data-sn-failed` in markup say sinter sets them; an unknown name hints at a row field (`r.id`) or a string, and `$site`, `$canonical`, `$slot` and `localeUrl()` are suggested.

### Changed

- A write through an alias marks what it aliases, both ways: after `sel = ys[1]; sel.n = 50` the row over `ys[1]` updates. An alias the compiler cannot follow (`reduce()`, a let, an event's detail, a component script's fields) marks every state scope and resource ([docs/spec.md](docs/spec.md#reactivity)).
- A `data-sn-for` over strings or numbers needs no `data-sn-key`: rows key by value and occurrence, duplicates included. SN103 (`missing-row-key`) is retired. A list chosen between resources with the same key keys by it.
- A resource without `key` that the build knows is a list (`type="string[]"`, the OpenAPI response, `file:` or `content:`) is `[]` while it has no data, where it was `null`; one of unknown type stays `null`.
- A list's empty state over an embedded resource, and a binding that reads its `$meta.<name>.loading` or `.error`, is in the first paint ([docs/first-paint.md](docs/first-paint.md#loading-branches)).
- `header(name, value)` takes a function for `value`, called for each request (``header('Authorization', () => token() && `Bearer ${token()}`)``; `null` or `undefined` sends none). A string was read once, so a token header sent `Bearer null` signed out and an old token after a sign-in with swaps ([docs/configuration.md](docs/configuration.md#the-request-layer)).
- The build's pages are the `.html` files under the root, as the dev server serves them, and `appType` is `'mpa'`: a config needs neither `build.rollupOptions.input` nor `appType`. A config that names its input builds those pages.
- A resource whose `src` starts with a value (`/{path}`, `https://api.example.com{path}`) is requested by the page module, not early: the build cannot see where it goes.
- `data-sn-options` (was `data-sn-listbox`) works on any element that holds options: it takes the focus, the arrows, Home and End move the mark, Enter and Space click it; `aria-activedescendant` follows the mark and `data-sn-marked` styles it ([docs/actions.md](docs/actions.md#lists-you-move-through-with-the-keys)).
- `render({ dev: false })` compiles a test's page as a build does.

### Fixed

- An OpenAPI operation whose `security` has `{}` beside a token is optional, not public: it was preloaded without the token, so a signed-in visitor could get the anonymous answer.
- A toggle's requests keep their order when a `data-sn-if`/`data-sn-else` swap replaces the running element: the element with the same `id` in the new branch carries on its concurrency state and `aria-busy`.
- `relative(date)` follows `$now`, so "3 minutes ago" moves on.
- A `<button type="reset">` or `form.reset()` updates the models of the fields it restores.
- A resource whose `when` turns falsy after a load is not loaded again; its `loadedAt` and `error` go back to `null`.
- A fan-out resource takes any error named `AbortError` as an abort.
- Escape on a `data-sn-options` list stays with the list only when it closes something, so a `<dialog>` around a menu closes.
- With swaps on: a `refresh` event held during a swap no longer sends a second request for a resource still loading; a history write while a swap waits no longer fetches the page again; the next page's new stylesheets apply only from the swap on; a list placeholder in a kept element no longer takes another node's id ([docs/sync.md](docs/sync.md#connection-rules)).
- With the Navigation API, `data-sn-on-sn-navigate` handlers are asked once for a link followed while a `$url` field's entry waits. Chromium 102 to 134 (no `sourceElement`) takes the path of browsers without the API, so `data-sn-swap="off"`, `rel="external"` and GET forms behave.
- The first paint has a `<template data-sn-text>` inside a row's, branch's or `<sn-component use>` case's element with no element before it, one right after an element showing the same expression, and a `data-sn-href` whose query values may leave their parameter out. `firstPaint()` and `render(html, { firstPaint })` now run the early script as a build does.
- With `localePrefix`, a `data-sn-href` whose literal start names one of the site's pages, and the API's `token.signIn`, are in the page's language (`/de/article/…`).
- `sinter check` on a page per entry in a subfolder no longer fails with "Cannot find module './sinter'", and types `$event.detail` of `data-sn-model` on a component as its `change` detail whatever its root element.
- The editor checks what `sinter check` checks (actions, component libraries, limits, lazy packages); editing a component keeps the libraries' components in `sinter.components.d.ts`, and a change to `sinter.config`, `sinter.early` or `sinter.content` reloads the project.
- `sinter render` loads the app's modules with its Vite config (aliases, plugins), runs a component script written as `.mts` or `.mjs`, and matches `--url` by the path's non-empty segments, as the browser does.
- The lazy packages' reach (SN324, `data-sn-preload`) and `prerender: 'auto'` follow the app's `resolve.alias` and `.mts`, `.cjs` and `.jsx` modules; `sinter check` walks `.mts`/`.mjs` component scripts for SN324, and a `.cts` or `.cjs` file beside a component is not taken for its script.
- sinter-axum reads a `:name` segment with a `%` that starts no escape (`a%20%zz`) whole, as the browser's `$url` does.
- Diagnostics: SN540 reports only scripts the browser runs; SN501 no longer reports a `file:` resource read only by a branch decided at build time or a list unrolled to no rows; SN331 no longer takes a name a function binds for a read outside it; `fields` and `drafts` on a fetched resource are SN332; one mistake in a `$meta` chain is one diagnostic; the message for an attribute a `file:` or `content:` resource does not take lists what it takes.
- `$meta.<name>.error` is documented and typed (`Meta`) with `detail`, as `$error` is.
- The starter no longer shows "No tasks here." beside "Loading…" while an empty list reloads, and the recipes are current (the offline-draft form's first autosave no longer clears the note's body).

### Performance

- Smaller pages: URL templates and early requests are compiled to code (the minimal page −297 B gzip, each RealWorld page −280 to 450 B); page modules carry only the templates and functions something uses, and templates written alike in a library's components are kept once (RealWorld's article about −1.5 KB gzip); a page whose modules call no message ships no messages runtime, and one language per page took 364 B off the shared head script and 757 B off the swap module.
- `@tiaforge-ui/sinter-markdown`'s parser is 1.6 kB gzip smaller (20.1 kB), with the same tokens.
- Builds: a page per entry is type-checked once per template (about 25% faster for 200 entries), and the dev server reads the project once until a file changes.

## 0.20.0 (2026-11-18)

### Changed

- A row whose item is replaced by another object, and a component whose props are replaced by other values, render again down to the components below them whose props did not change, instead of everything below. A component's markup reads only its props, its own state and what paths track, so nothing else below can have changed. A tree that grows by copies of the path to each change (the rest of it shared, rows keyed by a stable key) renders that path and the new rows: sinter-mail's 2,012-element newsletter renders in steps of 5 to 15 ms instead of 13 to 31 ms and growing, no frame is dropped while it grows, and the whole email is in place about 6% later than when everything after its first part renders in one task (it was twice as long). A change sinter knows of inside a value (a write below a list's path, a write of a whole state scope) still renders everything below, as before.
- A component's props compare equal when the compiler's own entries in them are equal entry by entry: the tree slots' fills it passes down (`$f`) and its tag's attributes (`$a`) are objects built at each evaluation, so a component that a tree slot reaches always rendered again with its whole subtree. And a component used inside itself, whose row is a computed list of its props, rendered again forced even when its props were the same values.
- **Behaviour change:** a computed list's kept rows (`data-sn-for` over an expression that is not a path, such as a helper's result or a component prop's children) rendered everything below them whenever the list was evaluated again, in case an item had changed in place without anything saying so. They now do so only when a change inside a value the list reads reaches it (see above); otherwise they render down to the components whose props changed. An item changed in place without a write sinter sees (mutated outside a handler, then the list evaluated again by another change) no longer reaches the components below it: replace the item, or change it from a handler.
- A component used inside itself, or chosen by `<sn-component use>`, no longer renders its whole subtree again each time one of its props' dependencies changes while every prop is the same value (each evaluation makes a new props object, which forced the subtree). It renders again, forced as before, when a prop is another value or a change of the round is inside a value a prop reads (`node.children[1] = …`, or the whole state). A 2,012-element email tree that passes a limit down: raising the limit in 400-node steps costs 264 ms in all instead of 407, and a step no longer costs more the more of the tree is rendered.

### Fixed

- With swaps on, a kept `<audio controls>` or `<video controls>` that plays on across a link now shows its controls in Chromium. The browser moves the kept element with `moveBefore`, after which it painted the controls as an empty bar until they were clicked; the swap now turns `controls` off and on again in the same task. The dashboard example's swap test checks that the controls are drawn after a link and after Back.

## 0.19.0 (2026-11-17)

### Added

- With swaps on, a stream both pages declare stays open across a swap ([docs/sync.md](docs/sync.md#connection-rules), [proposal](docs/proposals/stream-handover.md)): a `<sn-sync>` whose `src` resolves to the same URL with the same transport takes over the old page's connection instead of reconnecting, whether it is in a kept element or not; the next page's `<sn-event>`s and `app.on` listeners apply, and events that arrived during the swap are delivered to the next page once, in order, after it mounts (held up to 1000; past that, what the stream feeds is refetched). Streams the next page does not declare close. Builds without swaps are unchanged, byte for byte (a `SWAP` flag in the core's flags module).
- A helper module an early binding calls is no longer downloaded twice ([docs/first-paint.md](docs/first-paint.md#own-copies)): when the page script uses it too, it takes the early file's instance (its state, such as `md.parse`'s trees, is one for both), and imports a copy of its own only when the early file did not run (a swap: the page names the copy in `<link data-sn-shared>`). Shared when every early file that imports the module imports all of its exports and the build target has top-level `await`; the build's early-size line names large modules still in both, and why. RealWorld's article with embedded data: 22 kB brotli less JavaScript, the parser parsed once. Builds in which no early binding calls a helper module are unchanged.
- Swap navigation ([docs/navigation.md](docs/navigation.md#swaps), off by default): with `sinter({ swap: true })`, a link, `navigate()`, `location.assign()`, Back or Forward to another page of the app fetches that page's HTML and swaps it in through the Navigation API instead of a page load; elements both pages mark with `data-sn-permanent="name"` move into the next page as they are (media plays on, scroll and typed text stay), and may bind: the next page's code takes them over. `data-sn-swap="off"` on `<html>` or a link takes a page or a link out. Swaps carry view-transition types (`sn-push`, `sn-replace`, `sn-traverse`, `sn-back`, `sn-forward`), which page loads with a morph get too, and `data-sn-transition` morphs across a swap. `sn-page` on `document` after each page mounts. Diagnostics SN346 (`kept-element`), SN540 (`swap-script`: an inline or classic script a swap would not run) and SN541 (`kept-playback`).
- `data-sn-on-navigate`: a handler for every navigation away from the page while its element is on it (a link, one to another site too, `navigate()`, Back where the browser can still refuse it); `$event.preventDefault()` refuses it ([docs/navigation.md](docs/navigation.md#refusing-a-navigation)).
- Collections per language: `collection({ key, perLocale: true, load })` runs once per language of `localePrefix` with `ctx.locale`, and each language's pages read their own list (`sinter check` and the editor see the base language's); a shared collection that `get`s a per-language one, or `perLocale` without languages, fails the build. `chunks(list, size)` (`@tiaforge-ui/sinter/content`) pages a list for an index in pages built with `data-sn-pages`. On a `data-sn-pages` page, `$url.<param>` of its pattern is SN345 (`url-param-pages`: read the entry's field), and SN536 is an error.
- Collections ([docs/resources.md](docs/resources.md#collections)): `src="content:name"` reads a collection of the content module (`src/sinter.content.ts`, `sinter({ content })`), made with `collection({ key, load })` from `@tiaforge-ui/sinter/content`. Loaders run once per build in Node, before any page compiles, concurrently, with `ctx.files(glob, { drafts })`, `ctx.get(other)`, `ctx.env` (Vite's `loadEnv`) and `ctx.command`; their results must be lists of plain data with a unique key. On a page a collection is a constant list, as a `file:` glob is, and `data-sn-pages` builds a page per entry of one. A failing loader fails the build; in dev it is shown on the pages that read it (SN342 `unknown-collection`, also for a name the module does not export), and the dev server runs the loaders again when the module or a file they read changes. Loader errors are printed without URL credentials, queries or `env` values. `content` is a reserved API name (SN329). `fields="sku,name"` names what the browser gets of a `file:` or `content:` list it reads (each entry's fields); a collection that browser code reads must have it (SN344 `content-fields`), so a loader's other fields never ship. `sinter check` and the editor run no loaders: a `content:` resource without `type` is typed from its loader's return type, and its values come from the snapshot the build and the dev server write (`node_modules/.cache/sinter/content.json`); `sinter check` says when there is none, or it is older than the content module.
- A page per entry ([docs/static-pages.md](docs/static-pages.md#a-page-per-entry)): `<html data-sn-path="/blog/:slug" data-sn-pages="post in posts">` (or on a layout's tag) builds the page once per entry of a `file:` glob it declares, each written at the pattern filled from the entry (`blog/hello.html` at `/blog/hello`). The entry is a constant in the whole page, so everything over it is written at build time; it is typed as one item of the list. Each page has its canonical link at build time and is in the sitemap; the template is not written; no `_redirects` rule is needed; Speculation Rules name the pattern once. The dev server serves each entry at its URL. Errors SN340 (`pages-path`: the declaration) and SN341 (`pages-param`: an entry that cannot fill the pattern, or two that fill one path); a path another page or a `public/` file has fails the build. With `localePrefix`, each language builds its own entries (a `{$locale}` list reads its folder), paired with their translations by key for `localeUrl()` and the `hreflang` alternates, with a language chooser at each entry's unprefixed path. A link in a built page to a path a `data-sn-pages` pattern matches but no entry has fails the build, with the nearest entry (SN343 `broken-entry-link`).
- `file:` sources, checked and translated: with `type`, `sinter check` checks every file against it (an unknown field, such as `titel:` in one post's frontmatter, or a missing one, is an error at that file); `{$locale}` in a path reads each language's folder with `localePrefix` (`file:/content/{$locale}/posts/*.md`), the base language's in `sinter check` and the editor, and is `SN332` without it. The editor watches markdown and text files, checks the pages that read a file again when it changes or a glob gains or loses one (also for JSON, which it watched without acting on), and keeps the files and listings it read until then; the compiler keeps each file's parsed value while its text is unchanged. `sinter check` counts a markdown file or glob as typed.
- Builds minify each page's HTML ([docs/minify.md](docs/minify.md)), on by default, never in dev: your comments are removed, and the white space your stylesheets show to render nothing (runs become one character; white space beside block boxes, at the edges of a block, and between the items of flex, grid and table containers goes). It runs before the page is compiled, so sinter's own comments and the node paths of rows are counted on the minified markup. Each value is decided from the cascade at every breakpoint: `<pre>`, `pre-*`, editable content, markup a component's scoped styles reach, and anything the stylesheets cannot decide keep their white space; a page with a stylesheet from another origin keeps all of it. The example apps' HTML is 1–30% smaller after gzip (RealWorld 16%, the dashboard 30%), with screenshots identical in Chromium, Firefox and WebKit. `sinter({ minifyHtml: false })` turns it off; testing's `render(html, { minify: true, css })` renders a page minified.
- `sitemap.xml` ([docs/static-pages.md](docs/static-pages.md#sitemap)): with `sinter({ site })`, the build writes every page that may be indexed at the URL its canonical link names, under `base`, and with `localePrefix` each language's URL with every language and the chooser as `hreflang` alternates. Left out, and named in the build's line: `404.html`, `200.html`, pages with `<meta name="robots" content="noindex">`, pages whose own canonical link names another URL, and patterns with parameters without values. `sinter({ sitemap: { paths: { '/article/:slug': async () => slugs } } })` gives a pattern's values (a string, or an object by parameter name), each encoded as a path segment; a pattern no page has, a value that does not fill it, or a function that throws or returns no list fails the build. `sitemap: false` turns it off; an app's own `public/sitemap.xml` is kept; past 50,000 URLs it is a sitemap index over `sitemap-1.xml`, `sitemap-2.xml`, …. A site that already sets `site` gets the file on its next build.
- Warning SN538 (`unreachable-candidate`, `sinter check`): a candidate of `<sn-component use>` whose key the branches around it rule out, at its key. It was an error "in code sinter generated".
- Component libraries ([docs/libraries.md](docs/libraries.md)): `sinter({ components: ['@acme/ui'] })` names packages that ship sinter components as source, in the folder their package.json names (`"sinter": "./sinter"`): `components/` (public), `components/internal/` (the library's own), `sinter.helpers.ts`, `sinter.types.ts`. The app compiles them as its own components (constants, the early script, embedded data, type checks, scoped styles). A library owns its components' prefix; the app's `ComponentName` holds the public ones; its helpers come in through a namespace re-export (`export * as ui from '@acme/ui'`), followed through the package's entry to each helper's declaring module, which the page imports it from and which the fold check and the lazy rule judge, so a library's parser-free helpers stay ordinary while one that reaches a lazy package waits; type names in its components resolve against its own types module; its component scripts get their generated base classes and `sinter render` runs them. Its files are read through a workspace link outside the project root; in dev it is left out of dependency pre-bundling and watched; the lazy transform and lazy helper modules cover its modules. Its scoped styles are in `@layer sinter-lib`, which the page's stylesheet declares first, so the app's layers and unlayered CSS win. Diagnostics in its files name the file in the package and where the app uses it. Tree slots use the real package boundaries. `sinter check` in a library's own repository checks its `fixtures/*.html` pages.
- A package may import itself by its name (Node's self-reference): when a specifier names the package the importing file is in and that package has `exports`, the helpers manifest, the fold check and the lazy walk resolve it through its own `exports` with production conditions. A library's fixture pages re-export it by name (`export * as ui from '@acme/ui'`) and get its members ([docs/libraries.md](docs/libraries.md#checking-a-library)).
- Errors SN337 (`library-package`: not installed, no `"sinter"` folder with `components/`, a component both public and internal, more than one prefix), SN338 (`library-prefix`: two libraries with one prefix, or an app component with a library's prefix) and SN339 (`library-component`: an internal component used by the app, a tag in a library's prefix that names none of its components, a `<sn-component use>` map in a library naming a component outside it). Warning SN537 (`library-version`): sinter's version outside a library's `peerDependencies` range, or none listed.

- A helper may use `TextEncoder`, `TextDecoder`, `URL`, `URLSearchParams` and `structuredClone` and still run at build time: they behave the same in Node and browsers, and the last three were already allowed in expressions ([docs/static-pages.md](docs/static-pages.md#helpers-and-files-at-build-time)). A parser that names `TextDecoder` for byte input could not fold.
- Constant trees ([docs/static-pages.md](docs/static-pages.md#what-is-static)): a component used inside itself and the component an `<sn-component use>` renders, given constant props, are expanded at build time per instance, at any depth, and a tree slot's fill is written into each node that places it (a flat fill). A `file:./doc.json` content tree dispatched to one component per node type, with a link fill, is plain HTML with no script, template, anchor or text marker, and its images are optimized. A definition that nothing renders leaves the page.
- A row or tree node whose only run-time need is a handler that writes nothing and reads only constants, `$el` and `$event` (a copy button) is expanded at build time too; the page ships that handler.
- Warning SN536 (`expansion-limit`): the loop or component that would take a page past 10,000 rows and components expanded at build time; it is rendered in the browser. The `expansionLimit` compile option sets the limit.

- Tree slots ([docs/components.md](docs/components.md#tree-slots)): a named `<slot data-sn-prop>` that its component does not declare is filled by the nearest enclosing component that declares the name, through components used inside one another and inside themselves. A document component can let its page restyle every link at any depth. Each fill is compiled once as a template in the caller's scope; a placement in a recursive component is a choice between its default and the fill passed down. In a document test page, with a link fill and a heading fill, the article renders as many elements and bindings as without them.
- Warning SN535 (`close-slot-name`): a tree placement whose name is close to one its component declares.
- A component's root renders at most one element ([docs/components.md](docs/components.md#the-root)): besides one plain element, an `data-sn-if`/`data-sn-else` chain of roots (a button that is a link or a button), another component's tag (a variant with no wrapper), `<sn-component use>` (a dispatcher), or a `<slot>` whose default and fills are roots. The tag's attributes land on every branch, pass on through a component tag down to the element that renders, and land on a fill; a constant prop decides the root at build time. A component with a script or root state keeps one plain element.
- `data-sn-text` on a `<template>` renders a text node with no element ([docs/components.md](docs/components.md#text-without-an-element)): search highlighting, a list joined with commas, runs of text beside elements. It occupies one node, found again from the node before it at each write; a build-time constant (a literal, state nothing writes, a constant prop, an unrolled row's item) folds into the HTML as plain text. A fill may be a text (`<template slot data-sn-text>`). On a markdown test article, the article renders 1,370 elements instead of 2,831, as many as the same article from marked.
- An element that is the root of an outer component through its tag carries `data-sn-r`, and that component's root rules (`.primary`, `:scope`) reach it, outside `@scope`.
- Error SN334 (`empty-root`): `id`, `data-sn-model`, an action or `data-sn-transition` on the tag of a component whose root may render nothing. Error SN333 (`invalid-text`): `data-sn-text` on a `<template>` with another attribute or content.
- A constant class or style is written before the layout when it changes an image's size or a list's reserved space anywhere on the page, which a dry run of the layout decides: a class on a flex or grid sibling that changes an image's width now gives it exact `sizes` (a bound class in a flex row gave its images `100vw`). Pages where such a class changes nothing the layout feeds compile once, as RealWorld's do ([docs/spec.md](docs/spec.md#first-paint)).
- Constant loops are unrolled at any depth: a `data-sn-for` in a row of a constant loop, over the row's item, is unrolled too, a `data-sn-if` in a row (one that reads the row too) is decided per row, and `<sn-component use>` keeps only the candidate each row or use renders (and, with constant trees, expands it). All of it in the one second compile a page with constants already took, whatever the depth. At most 1,000 items per list, and (changed by constant trees) 10,000 rows and components per page in all, components counted too ([docs/static-pages.md](docs/static-pages.md#what-is-static)).
- `src="file:…"` on `<sn-resource>` ([docs/resources.md](docs/resources.md#files)): the project, read at build time, as a constant resource. One file is its text, a `.json` file's parsed value, or a markdown file's frontmatter fields and `body` (YAML's core schema: dates stay strings; anchors, aliases, tags and the fields sinter writes are refused). A glob (`file:/content/posts/*.md`: `*`, `**`, `?`, `{a,b}`) is a list with one entry per file, sorted by path, each with `slug` (the file's name, or its own), `dir` and `path`; `key` is `slug`, and two entries with one key are an error. `order` sorts it once at build time in the page's language, and `drafts="draft"` leaves entries whose field is `true` out of a build (kept in dev). Typed for `sinter check` with the fields sinter adds (`type` on a glob names one entry; markdown needs none). Written into the head as embedded data for what still runs in the browser, so the first frame has it and nothing is requested; `$meta` is constant, and the dev server reloads the page when a file changes, or when a file a glob matches is added or removed. The path is a literal, relative to the file that writes it or `/…` from the project root, inside the root; folders named `node_modules` or starting with a dot are not listed. `SN332` (`build-time-source`) for an interpolation, a missing file or one outside the root, invalid JSON or frontmatter, a glob's JSON file that is not an object, duplicate keys, `items` on markdown or a glob, `drafts` on one file, `order` on a value that is not a list, `file:` on an action or a stream, and anything that would load or change it (`refresh`, `cache`, `paginate`, `each`, `call`, `when`, `then`, `early`, store functions, write-through, stream events). Warning `SN539` (`empty-glob`) for a glob that matches nothing.
- The helpers module is loaded in Node before pages compile (the build, the dev server, `sinter check`, the language server), through Vite with the app's config, and each helper is checked for whether its calls could run at build time: only ECMAScript's deterministic globals, per exported function, through what it calls and imports, packages resolved with production conditions. A module that cannot load in Node is warning `SN533` (`helpers-unloaded`), once. It loads in a module runner over the app's config, not a dev server: the app's `configureServer` hooks do not run (a mock API's timer kept `vite build` from exiting), and a build loads it afresh each time (under `--watch`, edits count).
- Helper calls over build-time constants run at build time ([docs/static-pages.md](docs/static-pages.md#helpers-and-files-at-build-time)), in bindings and state initializers (never handlers): the result is written into the page, decides `data-sn-if`s, unrolls loops and initializes state, and a helper none of whose calls is left is not in the page's bundle. A call that throws, returns something that is not plain data, or (dev builds run it twice) returns another result, stays in the browser, with warning `SN534` (`helper-not-folded`) at the call in dev builds. On a `static` page, `SN322` names the helper call that keeps a binding in the browser and what it reaches. `file:` values are constants too: bindings over them fold, and a file nothing in the browser reads leaves the page. Testing's `render()` and `firstPaint()` fold helpers whose own source reads only their arguments. A helpers module that imports a stylesheet or an asset loads in Node as in the app; a helper that reaches an asset's URL, `?url`, `?inline` or a CSS module's class names stays in the browser, since the build gives those values of its own, while one beside a side-effect stylesheet import, or over `?raw`, runs at build time. Besides the globals, the check refuses `import.meta` in any form, `.constructor` and `__proto__`, `Math` and `Reflect` as values (`const { random } = Math`, `Reflect.get(Math, 'random')`), an error's `.stack`, and a function that assigns a module-level variable (`count++`). A page runs each distinct call once, however often its passes evaluate it. Every build runs each call twice and keeps one whose results differ in the browser; a production build also runs all its pages' calls again at its end, in a fresh copy of the helpers module and in reverse page order, and fails (SN534) on a result that differs, which catches state kept between calls (a table of ids) across pages. It is a guard against mistakes, not a sandbox.
- Slots that pass data ([docs/components.md](docs/components.md#slots-that-pass-data)): a member `cell: Slot<{ row: Row; column: keyof Row }>` of a component's props type literal is a slot that passes values to its fill. The placement passes them with `data-sn-prop` on the `<slot>`, checked against `T`; the fill (the caller's elements with `slot="cell"`, or a `<template slot="cell" data-sn-if>` chain) reads them as `$slot`, inlined as props are, so `patch($slot.row, …)` and `remove($slot.row)` act on the caller's resource, and an inner fill's `$slot` hides the outer one. A slot is not a prop: it is not passed in `data-sn-prop`, not in a script's `this.props`, and never required. `sinter check` types `$slot` and the placement; a hover on `$slot` in the editor shows its type and placement, and a hover on a tag lists what each slot passes. `Slot` is a global type in `src/sinter.components.d.ts`.
- A `<slot>` inside a fill of a slot that passes data places the children of the element the placement's default renders (a `<slot>` is filled by the nearest markup given content for it), per branch for a default that is an if/else chain; a forwarding `<slot name="link" slot="link" data-sn-prop>` passes them on.
- Error SN331 (`invalid-slot`): `Slot<T>` with `?`, in a type alias or inside another type, in `data-sn-head` or `data-sn-layout`, or a types module that exports `Slot`; `data-sn-prop` on a `<slot>` not declared `Slot<T>`, or a `Slot<T>` placement without it; a placement default that is not a root; a `<template slot>` that is not an if/else chain or a text; a `<slot>` in a fill whose placement renders no element; a default element that declares names its children read; and a `<slot>` that no component or fill encloses.
- Warning SN532 (`repeated-id`): a literal `id` in markup that renders more than once, in pages and components alike: a `data-sn-for` row, or a fill of a slot placed more than once. A page's loop was unchecked.
- **`memo()`** at `@tiaforge-ui/sinter/memo` ([docs/configuration.md](docs/configuration.md#memoized-helpers)): `export const parse = memo(parseDocument, { maxSize })` keeps an expensive helper's results by its arguments (primitives, plain objects and arrays of primitives, keyed one to one; anything else calls through). Object arguments are copied before the call, results are deep-frozen and shared, the cache is bounded by an approximate size (4 MiB by default, least recently used first; the last result is always kept, alone if it is larger), `.clear()` forgets it, and a call that throws keeps nothing. Lets and props stay their expression, evaluated at every read: a helper that is expensive on repeat calls is the app's to memoize. A memoized helper folds at build time as the function it calls does (`export const parse = memo(impl)` is a function of its own for the fold check, and the build's cross-check still finds state it keeps), and works in the page module and the early file.
- A `data-sn-let` can wait for a helper module that reaches a package of `sinter({ lazy })` ([docs/lazy.md](docs/lazy.md#helpers-that-wait)): such a module loads whole, with the package, when a let that calls one of its helpers is first read, and its functions stay synchronous (no stubs). The let is `undefined` until then (`sinter check` types it `T | undefined`), and the module's arrival renders what reads it; a failed load takes the unhandled-error path, once. A prop waits the same way. Not early. Testing: `render(html, { lazyHelpers: { md: { members, load } } })`.
- Constant images are optimized: a binding over build-time constants on an `<img>` (a `src` from state nothing writes, from a component prop given as a literal, or from the item of a constant list) is written into the page before images are optimized and the layout is computed, so the image becomes a `<picture>` with `srcset`, `sizes`, `width` and `height` and is checked like one written in the page (`SN511`, `SN512`; a choice between local images over constants, `dark ? './a.png' : './b.png'`, is no longer `SN513`). Its path resolves against the page, as in the browser. A constant class or style counts for the box, `sizes` and reserved space the same way. Such a page is compiled twice, as one with a constant `data-sn-if` or loop already was; on a page that already compiled twice, the class or image is written earlier and the `data-sn` ids after it shift ([docs/images.md](docs/images.md#what-is-optimized)).
- Lists, branches and choices are anchors as comments: the page holds two comments and the rendered elements per place, and `<sn-component use>` evaluates `use` once per node (it was one template and one evaluation per candidate). On a 2,963-node markdown article (headless Chromium, median of 5): 25,150 `<template>`s and 24,774 comments beside 2,831 elements become 0 and 8,218; LCP 424 → 316 ms, the response to rendered 346 → 255 ms, the heap 9.3 → 5.9 MB; a re-render 296 → 179 ms. Its page modules are 1.3–1.4 kB gzip smaller; the shared early file 0.3 kB larger (it finds comments too).
- A browser test harness that enforces Trusted Types: built pages under `script-src 'self'; style-src 'self'; require-trusted-types-for 'script'` in Chromium, failing on any violation report or console error (`test/vite/trusted-types.test.ts`).
- The early file writes the code of each template it renders once (`B[<id>]`) and references it wherever the template is used, instead of inlining it at every use.
- Warning SN531 (`encoded-body`): a `data-sn-body`, or a POST `<sn-resource>`'s `body`, that calls `JSON.stringify(…)`. sinter encodes the body itself, so the server got a JSON string instead of the object; a benchmark agent's login sent its fields this way, and `sinter render` showed it.
- `sinter render page.html` runs a page of the project from the command line on jsdom, with mocked or real API responses, and prints what happened: each request with its headers and status (the config module's middleware runs, so a token it adds shows), the rendered markup, each resource's `loading`, `error` and value (with a hint when the value is the response's wrapper and `items` is missing), history pushes and replaces, and the warnings. Steps (`--click`, `--input`, `--select`, `--check`, `--submit`, `--back`, `--forward`, `--wait`, `--emit`) each print what they changed. A `storage` section lists the localStorage and sessionStorage keys the page and the app's modules read, and a `--storage` key nothing read is a warning naming the keys that were (`--storage token: nothing read it; the page read \`ops.token\` (not set)`). Exits 1 when a request failed or had no mock, a `--storage` key went unread, a step could not run, or the page warned. The starter has jsdom, and its `AGENTS.md` points agents to `sinter render` before browser scripts. For coding agents: in the LLM benchmark, about half the debugging rounds were questions this answers in one command ([docs/testing.md](docs/testing.md#sinter-render)).
- Testing: `historyWrites()` on `render()`'s result lists every history push and replace; `diagnostics` has the build's warnings; recorded calls have the response's `status`; `mockRequests(routes, { fallback })` answers unmatched requests instead of failing them, and a function route gets the `Request` as its second argument.
- OpenAPI `security` decides how a resource is requested before the page module. A public operation (`security: []`) or a cookie one is preloaded even when request middleware exists; one that needs a token the app adds (bearer, an API key in a header or the query, OAuth) is not requested early or embedded, since that request would be refused. Without `security` the config decides, as before ([docs/apis.md](docs/apis.md#requests)).
- `sinter docs [topic]` prints one part of the docs that ship in the package: a section of `llms.txt` (`sinter docs layouts`), an attribute or element with the sections that use it (`sinter docs data-sn-for`), a diagnostic's explanation (`sinter docs SN318`), or the lines that have all of some words; `sinter docs` lists the topics. Coding agents read `llms.txt` several times per task, and every read stays in their context: the starter's `AGENTS.md`, `llms.txt` and every diagnostic's `docs:` line now point to it.
- Image sizes: more layouts give an image exact widths in `sizes` instead of an upper bound ([docs/images.md](docs/images.md#how-the-rendered-width-is-worked-out)), for static images and images from the API alike: grids whose tracks differ (`240px 1fr`, `2fr 1fr`, `minmax(0, 2fr) 25%`), with the column an auto-placed item lands in, lines (`grid-column: 2 / -1`) and named areas (`grid-template-areas`, `grid-area: main`); flex rows with fixed items beside ones that grow (a sidebar and a `flex: 1` main column, an avatar beside a body, unequal `flex` factors from a basis); and lengths in `em` wherever the font size is fixed by the stylesheets (a `.prose { max-width: 40em }` column, `padding: 0 2em`). Each is checked against Chromium at many viewport widths.
- Image sizes fall back per range of viewport widths: where a layout cannot be followed (text beside the image on phones, a sidebar that leaves no room on the narrowest screens), that range gets an upper bound from its containers or the viewport, and the others keep exact widths; before, one such range made the whole `sizes` an upper bound. The rows of a list in unequal grid tracks (and items whose column the build cannot know) get the widest column they can land in.
- Image sizes at every default font size: `rem`, `em` and `em` breakpoints are solved at 16, 24 and 12 px and written into `sizes` in `em` (which `sizes` and media queries read as the browser's default font size, whatever the page's root size), so a visitor with a larger default no longer gets files sized for 16 px. A range's end that mixes px and em becomes `min()`/`max()` of the widths that cross there, followed by the 16 px entries for browsers that skip math functions in `sizes`. Fixed boxes in rem (`size-12`) get `sizes` in em and a 2x file for a 24 px default. Breakpoints in em are written a hair before their end, past the 1/64 px to which Chromium compares media lengths. Expect `sizes` in builds to change from px to em wherever the CSS uses rem or em.
- Image sizes: grid columns with a minimum (`minmax(200px, 1fr) 300px`, `repeat(3, minmax(150px, 1fr))`) are exact: a column whose share is below its minimum is held at it and the others share the rest, as the browser sizes `fr` tracks, including on screens too narrow for every minimum. Rows of a list in equal columns with a minimum are exact, not a bound.
- Image sizes: a box's `width` or `max-width` in `ch` (`.prose { max-width: 65ch }`) bounds the images in it, at `0.7em` per `ch` (wider than any common text font's `0`), or a web font's `0` when wider, read from its file; a web font whose file cannot be read leaves it unbounded. Not followed in margins, padding, siblings or grid tracks, where a wider value could make the image narrower. `familyZeroWidths()` and `zeroWidth()` in `font-metrics.ts`; a WOFF2 with a transformed `hmtx` is not read.
- `SN530` names the fix for each image: when the resource's OpenAPI schema has the image's size next to its URL (`width`/`height`, `w`/`h`, `avatarWidth`/`avatarHeight`), the `width` and `height` to add to its `data-sn-attr`; the attribute it lacks when it has one of the two; else an `aspect-ratio` rule with a selector for it. Attributes and CSS only, no runtime code.
- Image checks run in Firefox and WebKit too (all three in CI): the widths the build computes render there, and each reads the generated `sizes` as Chromium does (Firefox at 12 to 24 px defaults).

### Changed

- A build keeps only the parts of the core its pages use ([docs/proposals/site-core.md](docs/proposals/site-core.md)), always, with nothing to configure: lists, branches, actions, dialogs, events, models, properties, styles and resources each stay only when a page of the build uses them (read from its IR), and the rest is compiled away. Every page of the build shares that one core. A minimal page loads 11.0 KB instead of 15.6 KB, a content site about a quarter less JavaScript, each RealWorld page 0.6 KB less. Dev serves the whole core. The test suite runs every page on the smallest core for its parts (`test/core-flags.ts`), the fuzz tests per seed.
- The RealWorld example renders its article body with `@tiaforge-ui/sinter-markdown` (`<md-doc>` over `md.parse(article.body)`) instead of marked and DOMPurify in an island: no `src/markdown.js`. The parser loads with the page; with embedded data the body renders in the early script, the parser in the article's early file (30.5 kB gzip, `earlyBudget` 40 KB): through sinter-axum (Lighthouse mobile) the article's LCP is its first paint, 1,359 ms, against 2,129 ms with marked and DOMPurify. Raw HTML in a body shows as text. `scripts/size.mjs` counts sinter's own packages with the page, so the article's budget is 62 KB (31.1 KB before, marked and DOMPurify's 22.4 KB reported apart and never counted; 59.8 KB now). `bench/markdown` measures `md.parse` in the page, a tree from the API and marked + DOMPurify on one article (packages/sinter-markdown/docs/markdown.md, Performance).
- `@tiaforge-ui/sinter-markdown`: the parser is 21.8 kB gzip instead of 34.5 (19.5 kB brotli), and parses a 48 kB document cold in 25 ms instead of 46 in Node. It leaves out what `md.parse` never runs (markdown-it's renderer, typographer and linkify, linkify-it, mdurl, uc.micro's tables) and packs its entity table (7.5 kB gzip instead of 11.5). Autolinks are GFM's, as github.com finds them, instead of linkify-it's: a bare domain (`example.com`, `config.md`) is text, a bare email (`foo@bar.baz`) is a link, `ftp://`, `mailto:` and `xmpp:` are linked, and a link's end is trimmed as GFM specifies (`www.a.com/x?q=(b))+ok`, `…&hl;`). Every other CommonMark and GFM spec example gives the same tokens as before.
- Size budgets ([scripts/size.mjs](scripts/size.mjs)): the minimal page 16 KB, RealWorld's article 28.5 KB (RealWorld runs with swaps on), a minimal page with swaps on 17 KB.
- A large page compiles in about linear time: which state fields the page module drops, and which dependencies each written path reaches, were decided pair by pair over the whole page. One page of 800 sections (713 kB of HTML, `bench/page-compile`) compiles in 1.4 s instead of 7.8 s, and one of 200 in 0.36 s instead of 0.82 s, with the same output byte for byte; pages of normal size build as before ([docs/proposals/parallel-page-compile.md](docs/proposals/parallel-page-compile.md)).
- A constant list unrolls at build time whatever its length, as long as the page's budget holds: the limit of 1,000 items per list is gone. It refused lists the page's limit of 10,000 rows and component instances allowed, and said nothing (no SN536). A list that crosses the page's limit is now SN536 at its loop. The limit is an option, `sinter({ expansionLimit })` (default 10000), for builds, `sinter check` and the editor alike.
- Builds compile each shared definition (a component used inside itself, or chosen by `<sn-component use>`) once and link it into every later page that needs it: the second time the build needs a definition, it compiles as a unit of its own and is recorded with everything it read of its page; a later page numbered alike before it that reads alike replays it, and any other page compiles it in place (a kind of page numbered otherwise gets a plan of its own). Dev, `sinter check` and the editor compile every definition in place, as before. A blog of one page per post (`bench/collections --files`) compiles a page in 21 ms instead of 34; the output is byte for byte the same, there and for every example app ([docs/proposals/compile-once.md](docs/proposals/compile-once.md), section 5). A definition that adds an action, a fill or a lazy import is compiled on each page, as before. If a build's output differs with it, `SN_NO_LINK=1` compiles every definition in place again, and `SN_LINK_AUDIT=1` names the page: it compiles each page also on its own and fails at the first difference (CI job `link-audit` runs the test suite this way).
- The expression parse cache is keyed by its options, then by the expression's text, instead of by one string made of both, which was built and hashed again at every lookup: 6–9% off each page's compile (`bench/collections`), the same output.
- A `data-sn-pages` template is walked once per build, not once per entry: each entry only evaluates the kept walk with its own value before the pass that writes its page, and the next-page data describes one entry per template. Component files are parsed once per process. The 100-post blog (`bench/collections`) builds in 2.4 s instead of 4.7 s, the 1,000-post one in 14.1 s instead of 37.9 s; the output is byte for byte the same, there and for every example app ([docs/proposals/compile-once.md](docs/proposals/compile-once.md)). A template that compiles an entry's own URL into its code (`$canonical`, `localeUrl()` with `localePrefix`) is compiled per entry as before.
- Builds compile each page once, and read what every page shares once per build: about 3× faster on a markdown blog of 100 posts (`bench/collections`, 21.2 s → 6.5 s; the same output, byte for byte, there and for every example app). Before, every page was compiled twice: once in `buildStart` to collect the early scripts, and again by `transformIndexHtml`, which wrote the page and overwrote everything the first compile had collected. Expressions are parsed once per source text and options (`src/compiler/parse.ts`; the trees are shared, so they are frozen), where the same expression was parsed at every node of a component tree and twice in each (once to find its end). The project's files the compiles read (components, layouts, `file:` sources, and the script beside each component, usually missing) and the project itself are read once per build and again at each build's start, so `vite build --watch` sees edits; dev reads afresh. `sinter check` and the editor are unchanged.

- The first change of only marked rows after a list renders, and its first selection change, find their rows by a scan instead of building a map or index of every row (built from the second change on): js-framework-benchmark's update every 10th and select row, measured cold after creating 1,000 rows, 875 → 800 µs and 550 → 515 µs (ivi 5.1: 795 and 490). A list with explicit keys takes the scan too, where it walked every row.

- Flat anchors: on the 300-block markdown article (`@tiaforge-ui/sinter-markdown`, headless Chromium, median of 21) comments 11,784 → 3,090 and template clones 6,597 → 1,523; script time 92 → 62 ms with md.parse in one pass; LCP level with marked + DOMPurify into `innerHTML`, from 8 ms behind. Core +242 B gzip.
- A wrapper's or a text run's head template is left out of the page unless the early file renders it (the page module never clones one): the markdown article's HTML 1,240 → 961 B gzip.
- `@tiaforge-ui/sinter-markdown`: `md.parse` builds its tree from markdown-it's tokens in one pass (no mdast between, no walk for definitions markdown-it resolved): the same trees, 38 ms cold instead of 47 on that article in Node. Its `./parser` export returns markdown-it's tokens.

- Faster rendering of nested anchors: a branch or a list's first rows, built inside a branch or row not yet on the page, render in place, so each node is moved once instead of once per anchor around it, and an `if` branch reads its anchor's scope instead of a new one. Whether a template's content is one element (a row then clones just that element) is decided by the compiler (`o` in the IR) instead of by the runtime per template. On a 2,963-node markdown article from an API, script time 97 → 83 ms and LCP 200 → 188 ms, level with the same article rendered by marked in an island (headless Chromium, median of 21); core +29 B gzip.
- Relaxed: a component's root need not be one plain element (`SN312` now reads "a component's root renders at most one element"). A placement's default may be any root, and a fill may be a text.
- A component's `data-sn-if` over constants is decided per use; before, uses that disagreed (`<x-tab data-sn-prop="{ on: a }">` and one with `{ on: b }`) left it a template. Two uses of a component on one line are told apart (before, their decisions and constant images had to agree). A constant loop's rows are compiled with their item's value instead of the whole list, so a long constant list no longer makes the build quadratic.
- Relaxed: `SN312` counts only placements of a slot that can render together. One `<slot>` of a name in each branch of one `data-sn-if`/`data-sn-else` chain is allowed, its content copied into each branch at build time, and a slot that passes data may be placed any number of times. The `<template data-sn-else>` right after a `<template slot="…" data-sn-if>` is now that slot's content too (it went to the default slot).
- The page module and the next-page data module import each helper from the module that declares it, as the early file already did, not through the helpers module: a page no longer loads the helpers module's other re-exports.
- A page module's first flush matches the rows of an unkeyed list it adopted from the early script by position, not by item identity: a let whose helper returns new objects for the same data (a parser) no longer makes the takeover replace every row. Measured on a long parsed document with embedded data: 1 of 2,831 elements kept before. After that flush, lists behave as before.
- A layout without props needs no `data-sn-layout`: a whole document in `src/layouts/` without it takes none. SN318 remains for a page that passes `data-sn-prop` to a layout that declares no props, with its own message. Agents left the attribute out of such layouts in every benchmark run that wrote one, and each paid a failed build for it.
- SN208 for `$event.target.value` ("Property 'value' does not exist on type 'EventTarget'") hints `$el.value` or `data-sn-model` for a handler on an input, select or textarea. For a handler on an ancestor (a form, a list), where `$el` is the ancestor and a form's `$el.value` would type-check and read the wrong thing, it hints moving the handler, `data-sn-model`, or a JSDoc cast of `$event.target`. `llms.txt` says so under magic names. SN315 on a layout's tag shows how a component tells the page something: an event in `data-sn-emits`, `emit()`, and a handler on the component's tag. Both came up in the benchmark baseline.
- Docs: docs/security.md and docs/spec.md said the browser test suite runs with Trusted Types enforced and a strict CSP. Only the e2e navigation pages run under a CSP (`script-src 'self'`, failing on a violation report); no test enforces Trusted Types yet. The core still writes no HTML, so `require-trusted-types-for 'script'` works without a policy.
- Docs: `ctx.request(url, { body })` in actions modules and island scripts encodes `body` as JSON itself, so pass the object, not `JSON.stringify(…)` (in `llms.txt`'s `data-sn-call` line, docs/actions.md, docs/islands.md and SN531's entry). A benchmark agent's login sent a double-encoded body from an action, where SN531 cannot see it.
- The `sinter render` hint in `sinter check`, `sinter docs` and `llms.txt` offers the running API (`--api http://localhost:<port>`) and a step (`--click`), not only mocks, and the testing section (`sinter docs testing`) starts with it. A benchmark agent saw the mocks-only hint five times and wrote a browser suite against its running API instead.
- `sinter check` ends with how to see a page render with data (`npx sinter render <page> --api mocks.json`) when a page loads data, and every section `sinter docs` prints ends with the same pointer. The starter has a `mocks.json` for its two pages and `npm run render`. In the benchmark, agents read the advice in `llms.txt` and `AGENTS.md` and still scripted a browser to see what a page shows; they do act on what their tools print and on the scripts in `package.json`.
- `llms.txt`: `$now` is a `Date`; compare and add with numbers through `$now.getTime()`. A benchmark agent's `$now > due` and `$now + 5000` failed the type check.
- `llms.txt` is the short version (23 KB): the opening rules, the attribute and element reference, the scope rules, what belongs in markup, magic names and store functions, then an index of the other sections as `npx sinter docs` topics. The full reference, recipes included, is the new `llms-full.txt`, which `sinter docs` reads. A benchmark agent read the 57 KB `llms.txt` with `cat`, and Claude Code showed it only a preview of that much output, so none of the file reached it.
- When the config module may change requests (`configure({ request })`, `header()`, `credentials()`), nothing is requested before the page module. An early request lacks what the middleware adds, so for a signed-in user with a token middleware each one was refused (a 401 in the console) and sent again by the page: one wasted request per resource. With an OpenAPI spec, public and cookie operations are still preloaded; the early file of a page with no early requests left carries no request code. The docs recommend an `HttpOnly` session cookie over a token in localStorage when you control the API: it works with early requests and preloads, and no script can read it.
- `llms.txt` names `sinter render` in its opening paragraph, next to `sinter docs`. In a benchmark run the agent never opened the starter's `AGENTS.md` and read `llms.txt` in slices, so it missed the paragraph at the end of the Testing section and debugged in a browser instead; the opening lines it did follow (`sinter docs`, 10 calls).
- `early="off"` is described as being for a resource a request middleware answers itself; one whose request a middleware changes (a token) needs nothing since the preload fix. A benchmark agent still put it on every resource up front, from the old wording.
- The starter's `AGENTS.md` and `llms.txt` say to read `llms.txt` once and look things up with `npx sinter docs` after that, and not to fetch sinter's docs from the web, which describe another version.
- `llms.txt` is half its size (109 KB → 56 KB): coding agents read all of it, and in a benchmark against Astro and SvelteKit that reading was most of sinter's extra cost. Eight recipes are shown in full without their tests (those stay in `docs/recipes/`), the others are listed with links; "First paint" and "Images" keep what changes what you write and leave how the build does it to the guides; the key-filter, `$url` history and `refresh` paragraphs are shorter.
- `llms.txt` and docs/strict.md recommend `sinter({ typecheck: true, strict: true })`, as the starter has: without `typecheck` a strict `vite build` passes with type errors and SN504/SN506, which only `sinter check` reports. A benchmark agent that set up a project by hand had only `strict: true`.
- `llms.txt` and docs/actions.md say how to write an inline edit with an optimistic change: leave edit mode on submit (`data-sn-on-submit="editingId = null"`), not in `then`, which waits for the server. A benchmark agent closed it in `then`, so a rename showed only after the PATCH answered.
- Faster builds: the OpenAPI specs and the helpers and actions modules are parsed once per file and content, no longer for each page and build step (RealWorld's `vite build` 1.98 s → 1.69 s; a 7-page app with 36 components 7.3 s → 6.3 s). The output is unchanged.

### Breaking

- Navigation goes through one chain per document where the browser has the Navigation API: a `navigate` event is the one source of links, `navigate()` and Back. A script's `location.href = '?q=2'` to the page itself, with only query parameters the page reads changed, now stays on the page (as such a link does) instead of loading it. A component can no longer emit an event named `navigate`, which is `data-sn-on-navigate`'s (SN209). `navigate(url)` to the URL shown replaces its entry, as `location.assign` does.
- **Helpers over constants fold.** A binding over a helper call with constant arguments is written into the HTML, and state initialized by one becomes a constant: bindings over it leave the early script and the page module, and a page can become static. A helper that breaks the purity contract while using only the allowed globals (it keeps state in its module) gets its result baked in; dev builds warn where two runs differ. Tests that used a pure helper to stand for a value only the browser knows see it written at build time.
- The tag's attributes on a component used inside itself now reach its root, where they were dropped.
- **The helpers module runs in Node**, in builds, the dev server, `sinter check` and the language server, as Vite plugins and the app's config do. Its top-level side effects run there too; a module that cannot load in Node (it reads `window` at its top level) warns with `SN533`, and its pages work as before.
- **`file` is a reserved API name** (`SN329`): an app with an API named `file` renames it. `src="file:…"` is now a file of the project.
- A `<slot>` that no component or fill encloses (on a page, or in a page's slot content) is an error (`SN331`); it was left in the HTML. `<slot>` inside a `<template>` that is not sinter's (declarative shadow DOM) is untouched.
- `Slot` is a reserved type name: a types module that exports one is an error (`SN331`) in an app with components.
- `SN324` is per module and per call: a helper module that reaches a lazy package is no longer an error; calling one of its helpers outside a `data-sn-let` or a prop is, with the hint to name it in a let.
- **The DOM shape of every list and branch.** A `data-sn-for`, a `data-sn-if` with its `data-sn-else`, a component used inside itself and a `<sn-component use>` render between two comments in place (`<ul><!--sn 4--><li>a</li><!--/sn--></ul>`; `<!--sn-->` in a row), and their templates are in the head as `<template id="sn-t-<id>">` (at the end of the body when nothing renders them before the first paint). No `<template>` element is left in the body ([docs/proposals/component-libraries.md](docs/proposals/component-libraries.md), section 1). So:
  - `:first-child`, `:only-child` and `:last-child` now match the first or only row, and `:nth-child` parity flips (the template was child 1): zebra striping changes. `h2 + p`, `p + p` and `* + *` now match between the rows a `<sn-component use>` renders, where its N empty candidate templates stood before each row.
  - `* + *` no longer matches the first row, and `ul:empty` matches an empty list (comments do not count).
  - `.children[n]`, `firstElementChild` and `childNodes` indexes shift in tests and scripts.
  - CSS, tests or scripts that select the templates in the body (`template[data-sn]`, `template[data-sn-def]`) find nothing.
  - In this repository, `.page-item:first-child .page-link` (`examples/realworld/src/styles.css`) now matches the pager's first row, as the RealWorld theme means it to.
  - Reserved space and image `sizes` count no element at the anchor: a row 1 at the start of its parent is `:first-child` for the build too, and the `if` form's placeholder after the rows no longer keeps `:last-child` off the last row.
- **Rows and branches that are one anchor or one text have no comments of their own** ([docs/proposals/flat-anchors.md](docs/proposals/flat-anchors.md)): a row or branch whose whole content is one `data-sn-if`/`data-sn-else` or one choice (a component whose root is a slot or a choice, a loop's row that is one branch) renders as what its anchor renders, with an empty comment while that is nothing; one whose content is one `<template data-sn-text>` is that text node. `childNodes` counts in tests and scripts change (CSS does not see comments). The server's HTML, the early script's first paint (adopted as it is) and the head templates are unchanged.
- **An author's comment whose text is exactly an anchor form** (`<!--sn-->`, `<!--sn 4-->`, `<!--/sn-->`, or the empty `<!---->` of a text separator) is an error (`SN105`); the runtime and the early script match only those forms, so `<!--snippet-->` and every other comment stay the author's.
- **`$el` in an `if`, `for` or `use` expression** is an error (`SN213`): the anchor is a comment, with no element.
- **An anchor inside `<textarea>` or `<title>`** (a `<template data-sn-…>` or `<sn-component>` there, which the parser reads as text) is an error (`SN106`), where it was silent.
- **Shared definitions are head templates**: `<template id="sn-def-<name>">` is `<template id="sn-t-<id>">` (with `data-sn-name` in dev builds), the empty `<template data-sn-def>` in the body and the `@tiaforge-ui/sinter/defs` feature module are gone, and the early script no longer fills a template from a definition.
- **The IR** (still v2, read by the runtime of the same release): an if's `data-sn-else` is its binding's `z` and has no node of its own; `<sn-component use>` is one node with a binding of kind `ch` (`c`: each case's template); an anchor's node has the tag `#`; a template inside `<svg>`/`<math>` has `w`. The early writers `iff(start, v, x, z, a, b, s)`, `each(start, list, x, r, item, index, s)` and the new `ch` take the anchor's start comment and template ids.
- **HTML comments must reach the browser**: a minifier or CDN that strips them breaks lists and branches. Dev builds warn for a missing or duplicate anchor (codes 1–3) and for one without its end comment (31).

### Fixed

- An array parameter (`$url.sender` bound as a list) is a list right after a same-page navigation (`navigate('?…')`, a same-page link), not only from the next render: what is evaluated in between, such as the lets after a resource's `then` that navigates during the mount, no longer reads it as missing. Seen in caley on a swap into its mail page, whose cached `accounts` navigate to the default view.
- Swaps: a branch in a kept element (`data-sn-permanent`) that the page before showed as none, and the next page too, no longer makes the next page's mount throw, which reloaded the page. Seen in caley: calendar → mail → settings with the rail's notifier branch.
- A server event that only an island or a component script listens to (`app.on`, no `<sn-event>` maps it) is delivered after the stream reconnects, and when its listener came while the stream was retrying: each connect subscribes the names `app.on` listens to, not only the mapped ones. Found in caley, whose new-mail notifications stopped after the backend restarted.
- Swaps with `localePrefix`: a page in another language (`/en/settings/` → `/de/settings/`) is a page load, as documented, not a swap that kept the old language's links in a `data-sn-permanent` element (`<html lang>` of pages without the language picker is now part of what only a load applies). The messages a page's modules call (its `data-sn-messages`) join the dictionary when it is swapped in, so a helper's `m.key()` no longer returns the key when the first page shown lacked it.

- Testing: `settle()` did not run the task that releases a dialog a close button (`command="close"`, a `method="dialog"` submit, Escape) closed, so after the dialog opened again its bindings stayed as they were until a test called `advance(0)`. `settle()` runs it now. Browsers were not affected.
- `data-sn-preload` with a lazy package that the app imports through a subpath (`lazy: ['@tiaforge-ui/sinter-markdown']`, whose `md.parse` imports `@tiaforge-ui/sinter-markdown/parser`) preloaded nothing and warned `SN520`: the package's name was matched against each import exactly. It matches the package's subpaths now, as `lazy` does.
- A component library linked from outside the app's root (`file:`, `npm link`) whose helpers import sinter (`@tiaforge-ui/sinter/memo`) failed the build when its helper was in the early script: the early script's bundle took the app's `resolve.alias` and `resolve.conditions` only, so the app's `resolve.dedupe` (and `preserveSymlinks`) did not reach it and the import resolved from the library's real path. It takes both now.
- A component library in `sinter({ lazy })` re-exported as a namespace from the helpers module (`export * as md from '@tiaforge-ui/sinter-markdown'`, the setup [docs/lazy.md](docs/lazy.md) and the markdown library describe) failed the build with SN324 once a page also called another of the app's helpers in the browser (`signedOut()`), and with SN325 when that helper ran in the early script. Pages import each member from the module that declares it, so the helpers module's re-export of a lazy package is now dropped from the page bundle and the early script, and `sinter check` no longer reports it; a module of the lazy library itself is left as it is. A re-export of a lazy package in any other module is still SN324.
- A dialog closed by the browser after a handler changed its state no longer empties while it fades out: a `command="close"` or `request-close` button (`data-sn-on-click="draft = null" commandfor="edit" command="close"`), a submit of a `method="dialog"` form, or Escape in a modal dialog. The handler's changes rendered before the close, so the dialog's text and fields vanished during its exit transition; its bindings now wait as in a closed dialog, and render a task later if a handler prevented the close.
- A list computed from others (`data-sn-for="x in xs.slice()"`, `xs.filter(…)`, a helper over a list) renders a change to an item in place (`xs[0].t = …`, a `forEach` write): its rows did not, as what they read of the item had no dependency. When such a list is evaluated again, the rows it keeps render again.

- A component whose root is its slot, with a named fill (an element, a chain or a component tag), in a loop or a branch of another component's slot content failed the build over constants (`SN201`): its scope now starts in the slot content's writer's scope and rows.
- A component whose root is an if/else chain or another component's tag, used inside a component with a plain root, resolved its names in that outer component: over the outer's constant props its branch was decided by them and its text was theirs (`<button>OUTER</button>` for a link), at run time too.
- Slot content holding a `data-sn-for` or `data-sn-if` template whose content is a component with an if/else, component-tag or choice root failed the build over constants (`SN201`), and so did `<sn-component use>` directly in slot content: each now compiles in the scope of the markup that wrote it.
- A slot-root component filled by a component-tag-root component (`<x-slot><x-var slot="item" …>`) failed to build: the components whose markup starts at one node were ordered nearest first, three levels deep.
- A fill of a tree placement with two `<slot>`s that can render together is `SN312` over state as over constants (it compiled over state and placed the children twice).
- Over constants, a component tag used as a fill of a slot a list places per row rendered the first row's `$slot` in every row (its props, its class and attributes, a chain or tag root, slot content in the tag, a nested fill), with no diagnostic.
- `<sn-component use>` inside a component, over that component's prop, choosing a component whose root is another component's tag over an if/else root, failed the build over constants with `SN201` in the chosen component.
- A literal text (`data-sn-text="'~'"`) right after a text the previous row of a constant loop ended with hid the node after it: that node was left a `<template>` in the HTML.
- In a constant tree, a fill of a tree placement that places the node's children with a `<slot>`, an if/else chain fill, and a component tag fill are expanded at build time (they rendered in the browser; on a static page, `SN322` named only the resource). A component whose root is a choice, among the children a fill places, read the default's loop names. A fill that holds a component with slots of its own, or that a wrapper passes on, still renders in the browser, and `SN322` names it with why.
- A `<template data-sn-text>` after a list or branch in a row or a branch was lost or misplaced at run time (inside the next anchor, removed by a later render): its path did not count the anchor's two comments.
- A `data-sn-if` on an optional prop (`data-sn-if="href"`) in a component used inside itself or chosen by `<sn-component use>` was decided at build time as if the prop were left out: the shared definition's tag gives no props. It is decided per instance.
- In a branch, a node after a nested list, branch or choice was not found at run time: the walk that finds a branch's nodes counted an anchor's two comments as one, so a loop or a bound element after an inner `data-sn-if` (an optional separator before a list) did not render. Builds over constants were not affected.
- The early script left the page module stale node lists for a row, branch or choice whose top node is a `<template data-sn-text>`: when the page module did not adopt them (another number of rows, another branch or case), the texts stayed beside the new content. The lists now hold the texts, and what is not adopted is cleared between the anchor's comments, with nested anchors' contents.
- A component's tag as a fill of a slot that passes data (`<x-pill slot="item" data-sn-prop="{ t: $slot.x.t }">`) can read `$slot` in its props and attributes; it was SN201.
- A text fill of a `<slot>` that is a component's root was SN312 when expanded at build time (over constants) and allowed over state. It is allowed in both: the root renders one text node, and attributes on the tag are SN334.
- A component whose root is not one plain element (an if or if/else chain, another component's tag, a slot that passes data), used below the top of a constant row, rendered the first row's values in every row, with no diagnostic: each row's branch was right, its text and attributes the first row's. Each copy now compiles its component's markup in its own row.
- A fill that is an if/else chain over `$slot` failed with `SN201` (`$slot` is not available here) when the placement's values were constant: the branch decided at build time is now that fill.
- A constant tree through a component reached again by `<sn-component use>` in its own rows (a list in a list item) expands at every level; its second level stayed in the browser. A `static` page that keeps such a part in the browser now reports `SN322` (it shipped a page module with none).
- An `id` on one use's tag of a component used more than once was reported as an id in the component's markup (SN209). It is that use's; a literal id in the component's own markup still is.
- A minified build (Vite's default) with a lazy package could ship a page module with a syntax error (`Unexpected token 'import'`): the runtime kept the chunk mark as a constant, the minifier made it a template literal, and the build's patch of the loaders' chunk URLs matched from there across code to the next mark, replacing all of it. The patch now matches inside one string literal only, and the runtime no longer holds the mark (it takes a URL starting with `.` as the chunk's). Builds with `minify: false` were not affected.
- A tree placement that is its component's root, rendered with no fill, reported `SN201` for the component's own names in its `data-sn-prop`: it was compiled in the caller's scope. The output was right.
- `sinter check`: a map in `<sn-component use>` followed by a `data-sn-else` accepts keys outside the map, as the build renders the else for them. The else template, and the branches of a `data-sn-if`/`data-sn-else` chain, are checked with the data narrowed by their conditions, so a member only one type of a union has type-checks in its branch.
- A constant tree through a component whose root is a `data-sn-if` chain (rendered by `<sn-component use>`, or used inside itself) stayed in the browser below that root: a loop in the kept branch, or a chain nested in its `data-sn-else`, was not unrolled or decided (`SN322` on a static page).
- A state change did not re-render content of components used inside one another (a link in an emphasis in an emphasis): the runtime's template dependencies were memoised mid-recursion.
- The tag's attributes on a component used inside itself (and a component's tag attributes when its root is `<sn-component use>`) reach the root the shared definition renders: plain attributes, `data-sn-class`, `-attr`, `-style`, `-show` and handlers. They were dropped silently; other sinter attributes there are `SN102`.
- Plain slot content at the top of a row of a component's loop over constant state failed the first-paint build (`SN201` on the loop's list): the unrolled row's item went onto the caller's scope instead of the component's.
- A `<template data-sn-for>` (or `data-sn-if`) inside `<svg>` or `<math>` crashed the build (parse5 gives a foreign template no content). Its head template now holds the `<svg>` (or `<math>`) and a row is made of its children, so `<circle>` is SVG.
- An early render that failed partway (nodes between an anchor's comments, no mark left) was doubled by the page module; it is cleared.
- `sinter check` (and `vite build` with `typecheck`) of a `static` page: a component prop inside a `data-sn-for` over constants was SN208 "Cannot find name 'p'". The check read the page after the loop was unrolled at build time, where its rows have no loop variable; it now reads the page as written. Checking the page by name passed, because then the Vite config's `static` was not read. A benchmark agent dropped `static: true` to get past it.
- `<sn-component use>` inside a `data-sn-for` failed in the browser (`Cannot read properties of null (reading 'content')`) when the row was rendered: the shared definition was looked up in the row template's inert document. It is looked up in the page's document.
- Components that use each other through `<sn-component use>` (a block holding inlines, an inline holding inlines) made the build overflow the stack with `embed: true`: the early file inlined their branches without end. Each such branch is written once and referenced.
- Request middleware that adds a header (a token, `header()`) now reaches resources with a fixed `src`. Their `<link rel="preload" as="fetch">` handed its response to the page's request whatever headers the middleware added (Chromium reuses it in every `cache` mode), so the header never reached the server: a signed-in `/api/me` answered 401 and `onUnauthorized` redirected to the login. When the config module may change requests, the build writes no preload links for resources; the early script requests them, and its response is used only for an unchanged request.
- A `$url` write from a handler on `change` of a `<select>`, checkbox or radio is a choice, a new history entry, decided at build time as for `input`. It depended on the event being trusted, so under Playwright's `selectOption()` (which dispatches untrusted events) it replaced the entry and Back left the page, while it worked for users; a `data-sn-model` was not affected. No runtime bytes.
- `sinter({ firstPaint: false })` no longer turns off build-time constants and pages without JavaScript: with it, a `static` page's constant bindings (a layout's props given as literals) were SN322, and a page with nothing to run printed `no JavaScript` but still got a page module and its `<script>`. It now turns off only the early script and reserved space.
- SN318 for a layout whose `<html>` has no `data-sn-layout` hints `data-sn-layout="{}"` when the page passes no props; SN322's hint says a binding over constants is written in at build time.
- SN506 (`untyped-event`) names the payload type to write: `item="incident"` on a resource of `Incident[]` hints `type="{ incident: Incident }"`, also when the `<sn-sync>` comes before the resource. Agents in a benchmark needed several builds to find the shape.
- `sinter check`: `$error` passes to a helper or action that takes a `SinterError` (`@param {import('@tiaforge-ui/sinter').SinterError} e`). The checker's type for `$error` lacked the `name` and `stack` a `SinterError` has as an `Error`, so the call was SN208 "Property 'name' is missing in type 'Err' but required in type 'SinterError'", and `$error.stack` was SN208 too.
- A list the build cannot trace to one resource (a helper's result: `m in visible(messages, q)`), and `patch(item)`/`remove(item)` on a row that can come from several (`a in (mine ? tags : messages)`), no longer warn "item is missing key field" for each other keyed resource on the page: a resource whose key fields the item lacks is passed over. It was console noise since 0.12, but each one failed `render()` in strict mode.

## 0.18.0 (2026-11-14)

### Added

- Reserved space: a paginated list (or a choice between paginated resources, or one with a `when` over the URL) whose rows arrive after the first paint holds their space from the first frame, sized from the stylesheets (each row in its place, for every default font size, a share of the container's width where the height follows it): exact where they fix the rows' height, a lower bound otherwise (a bound text one line; `line-height: normal` the least of every face in the font stack: the page's fonts read from their files or fallback faces' overrides, a built-in table of system fonts, the generic family on every platform, so `font-display: swap` keeps it). Rows stacked, in a grid, table rows in a `<tbody>`, or with a width of their own side by side or wrapping in a flex row. Builds write an `aria-hidden` placeholder after the template, its rule in the page's stylesheet, and a binding of the page that removes it when the rows arrive or no load is running: no runtime code ([docs/first-paint.md](docs/first-paint.md#reserved-space)).
- A "Loading…" branch right before such a list takes the placeholder's place, with the rows' height. Any other loading indicator over the same status anywhere on the page (a branch, a `data-sn-show`) leaves the list without space; the build reads those conditions, it does not run them.
- A differential test lays random lists out in Chromium against the space held (`test/compiler/reserve-fuzz.test.ts`, `SINTER_FUZZ=<n>` for more cases).
- The build prints each paginated list it holds no space for, and why.
- Warning `SN530` (`unsized-late-image`): an image (video, iframe) without a height in rows that arrive after the first paint.
- Same id, same control: when a `data-sn-if`/`data-sn-else` swap removes the focused element, the element with its `id` in the new branch takes focus (a toggle written as two buttons, follow and unfollow, keeps the keyboard focus across a click). Without an id twin, focus is not moved. RealWorld's favorite and follow buttons use it.
- `navigate(url, { replace })`: a store function for handlers, `then` and `catch` (`data-sn-then="navigate('/article/' + $result.article.slug)"`). To this page with only parameters it reads changed, it is a same-page link (no load, a history entry, `$url` read again; such a page loads `@tiaforge-ui/sinter/query-links`); anywhere else the browser loads the URL, as a new entry or, with `replace: true`, in the current one. `navigate` is now a store-function name: a resource cannot take it (SN209).
- A list over late data in a box whose width follows its content (a flex item without a basis or width, a float): in a build, what follows the box stays invisible while the list's first rows load (`visibility: hidden`, a `:has()` rule over a marker the page removes, at the screen widths where the box follows its content, for at most 3 s), so the rows widen the box without moving anything that is shown. The build prints each such box; `data-sn-wait="off"` on it keeps what follows shown and reports `SN529`. A choice between resources hides only during the first load of those the early script knows. RealWorld's home page, Lighthouse mobile: CLS 0.151 → 0.000, performance 93 → 100 ([docs/first-paint.md](docs/first-paint.md#a-box-whose-width-follows-the-list)).
- Warning `SN529` (`content-sized-list`): a list over data that arrives after the first paint inside a box whose width follows its content (a flex item without a basis or width in a row, a float), where the rows have no width of their own; its rows widen it and move what is beside it. A new warning: with `strict`, a build fails on it unless `strict: { allow: { SN529: '…' } }` (as RealWorld does for its shared theme); SN530 likewise.
- A resource's status at mount (no data, loading if its `when` holds) is compiled into the early script: a branch over `$meta.<name>.loading`, `.error` or `.loadedAt` and the resource's rows (`!people.length`) is in the first frame, and the page module adopts it; the early runtime is unchanged ([docs/first-paint.md](docs/first-paint.md#loading-branches)).
- Same-page links: a plain click on a link to the page itself that changes only query parameters the page reads stays on the page, as a new history entry, and shows what loading the link's URL would show (a `page-model` list loads the link's page). Links to another path, with `download`, a `target` or `rel="external"`, modified clicks and parameters the page does not read load as before; next-page data and Speculation Rules leave same-page links alone. Loaded (`@tiaforge-ui/sinter/query-links`, 0.7 KB gzip) only on pages with a link the build sees goes to the page ([docs/navigation.md](docs/navigation.md#same-page-links)). `SN519`: a pager link (a static query-only `href` that sets a `page-model` parameter) that drops other parameters the page reads.
- Strict mode, `sinter({ strict: true })` or `SINTER_STRICT=1` (`0` turns it off), for CI and coding agents ([docs/strict.md](docs/strict.md)): warnings fail `sinter check` (`--strict`, `--no-strict`, `--allow SN504,SN517`), `vite build` (a page's warnings as its errors do; the build's own once it has run, all listed), pages in the dev server, and `render()` in tests (`strict` option; a runtime warning rejects the call that ran it). In the dev server the runtime's warnings in the browser are printed in the terminal and shown in Vite's overlay. `{ allow: { SN504: 'reason' } }` keeps codes warnings, each with its reason. Warnings that depend on the machine, the network or the browser (`SN525`–`SN528`, an HTTP/1.1 stream, a CSP header, …) and `SN507` stay warnings. `warnings()` on `render()` lists the runtime's warnings in or out of strict mode.
- `npm create sinter`: the starter builds in strict mode (`sinter({ typecheck: true, strict: true })`), and its `AGENTS.md` tells coding agents to keep it on and to allow a code only when the user agrees. `llms.txt` says so at the top.
- Codes for the build's warnings, printed as `sinter: warning SN5xx name: …` with a link to their docs: `SN520` (`unused-preload`), `SN521` (`redirected-link`), `SN522` (`untranslated-messages`), `SN523` (`early-budget`), `SN524` (`redirects-limit`), `SN525` (`images-unoptimized`), `SN526` (`font-download`), `SN527` (`css-image-sizes`), `SN528` (`remote-image`).
- `packages/sinter-aspnetcore`: `Sinter.AspNetCore`, sinter-axum for ASP.NET Core, at feature parity: `app.UseSinter()` fills a build's placeholders per request, streaming the head first, from the app's own minimal APIs and MVC controllers called in-process (through routing, authentication and authorization, the page's cookies forwarded), an upstream server, an allowed origin or a resolver; it follows the build's redirects, rewrites and language choice. `[SinterEmbed]`, a source generator, compiles the build's manifest in and refuses, at compile time, a placeholder without a source or a name no placeholder has; resolvers are static methods whose services and arguments are bound in generated code. NativeAOT-compatible. Released with sinter, at the same version.
- `@tiaforge-ui/sinter/server`: the server layer for JavaScript, on web-standard `Request` and `Response`, at feature parity with sinter-axum. `await embed({ dir: 'dist' })` and `sinter.wrap(app.fetch)` serve a build's pages with their API data written in, the head streamed first, from the wrapped app called in-process (the page's cookies forwarded), an upstream server, an allowed origin or a resolver; it follows the build's redirects, rewrites and language choice. It runs on Node, Bun, Deno, Cloudflare Workers and inside Hono or any fetch handler ([docs/server.md](docs/server.md)).
- `sinter({ apis })`: the APIs an app calls, configured once ([docs/apis.md](docs/apis.md)): base URL (per build, from an environment variable; `undefined` is an error), OpenAPI spec, `credentials`, static `headers`, what each endpoint returns (`defaults` for the spec's operations, `operations` for endpoints it lacks), `defaultApi`, and the built-in `site` API. `src` on resources and streams and the action method attributes then take paths relative to an API (`src="/articles"`, `data-sn-delete="billing:/invoices/{i.id}"`), checked against the spec: `SN326` (no such operation), `SN327` (undeclared or missing query parameter, including `paginate`'s), `SN328` (absolute URL), `SN329` (invalid config), `SN330`/`SN518` (a resource restating a configured `items`, `total`, `key` or `type`). Each request carries its API's credentials and headers: the page module, the early file (whose response is still taken), preload links (`use-credentials`), and the server layers (the manifest lists the headers; `@tiaforge-ui/sinter/server`, sinter-axum and Sinter.AspNetCore send them, its source generator compiling them in). `apiOf(url)` names a request's API for middleware; `render(html, { apis })` in tests.
- `<sn-resource method="POST" body="{ q }">`: a resource that loads with a POST of its body (search, reports), shared by URL and body, reloaded when the body changes; not cached, preloaded, requested early, prefetched or embedded.
- `sinter migrate [--write]`: rewrites the URLs of the pages, components and layouts into paths relative to the configured APIs (and the page's own same-origin paths into `site:` where no operation of the default API matches), prints the `defaults`, `operations` and `query` parameters to add, lists what only the author can fix (a likely typo of a query parameter, a required one left out), and removes the attributes the config then restates. The examples use `sinter({ apis })`.
- The language server completes paths to an API in `src` and action values (matched anywhere in the path, the operation's id or summary; parameters as snippet placeholders) and their query parameters, shows the absolute URL on hover, goes to the operation in the spec or the config, and quick-fixes `SN326`, `SN328`, `SN330` and `SN518`.
- Warning `SN517` (`unkeyed-list`): a resource without `key` whose OpenAPI response is a list of objects. It loads and renders, but it is one object holding the list, so an `upsert`, `patch` or `remove` acts on the whole list.
- With `embed: true`, the build also writes `sinter-embed.d.ts`: with `embed<Build>()`, a placeholder left without an entry, or a name no placeholder has, is a type error in the server's code.
- `$url` is bindable: `data-sn-model="$url.q"` on a field, a select, radios, checkboxes or a component (SN203 names the forms it takes; `data-sn-persist` on one is SN102). History behaves as in a single-page app ([docs/navigation.md](docs/navigation.md#the-url-and-the-history)): a write a user's event caused (a click, a select, `page()`, an action's `then`/`catch` it started) adds an entry; typing commits at each 250 ms pause, the first commit of a run adding an entry; anything else replaces; a number or range field's burst of steps (spinner clicks, arrow keys) is one entry, at its pause; Back and Forward restore what the user saw and write nothing. One write per flush; parameter order is kept. An object written to `$url` is `SN212` (at run time it deletes the parameter, with a dev warning). The pause lives in `@tiaforge-ui/sinter/typing`, loaded only by pages with a text, number or range model on `$url`.
- `page-model="$url.page"` on `paginate="offset"`: the list's page lives in the URL, read at load (also in the early request, preloads and embedded data) and written back by `page()`; the list follows the parameter, a filter change starts at page 1, Back returns to the page ([docs/pagination.md](docs/pagination.md#page-in-the-url)).
- Array parameters: a `$url` parameter bound to a `<select multiple>` or to checkboxes with a `value` is a list (`?tag=a&tag=b`, `[]` when absent), in the runtime, the early file, next-page data and the server layers. `SN210` (bound as a list and as one value, or a list written to one value) and `SN211` (a bare list in a condition).
- Testing: `history()`, `back()` and `forward()` on `render()`; the events a test dispatches count as the user's.
- Recipes: pagination in the URL, search in the URL, a multi-select filter in the URL.

### Changed

- Build-time work the runtime did at mount, per page:
  - The event types a page listens for are listed by the compiler (`IR.ev`, in the page module): the mount adds one listener per entry instead of walking every binding of the page and its templates, and a page without a dialog or a non-text model has no `toggle` listener. Core −75 B gzip (RealWorld pages −50 to −58 B).
  - The resources a server-event stream feeds are flagged by the compiler (`fed`): the mount read every stream's events once per resource and once more for the set that `pageshow` and `online` leave to the stream. Core −48 B gzip (RealWorld pages −46 to −55 B).
  - A row template's kind is decided by the compiler (`sm`: a simple template, whose rows keep no binding objects; `ri`: its rows read a loop index, nested templates included): the runtime reads a flag where it walked the template's bindings, and its nested templates', when a list first rendered. Core −110 B gzip (RealWorld pages −110 to −115 B). A component used inside itself whose inner copy alone reads the index is now always re-run when its row moves (it depended on which list rendered first).
- `npm run release` bumps `examples/dashboard` too (sinter, temper and its inspector, as in the starter): StackBlitz installs it from npm, and on 0.x its caret range kept it on an older sinter than its pages were written for, so the StackBlitz link failed to build.
- Dev-only text that shipped in production: the warnings for a stream event that could not be applied or whose payload lacks a key field, and for `page(name, 'last')` without a known total, are codes (28, 29, 30) whose text is in the dev module, as the core's warnings are. The messages are unchanged; `warnings()` in tests now gives their `code`. `sse` 1807 → 1751 B gzip, `paginate` 1794 → 1775 B (RealWorld index and profile −20 B).

### Breaking

- A link to the page itself that changes only query parameters the page reads no longer reloads the page: `data-sn-state` stays, and there is no cross-document view transition.
- `start-page` is renamed to `page-model` (offset lists, a query parameter: `page-model="$url.page"`), which also writes the page back; `start-page` is SN401. A start page from a path segment, from another expression, or for keyset lists with `offset-param` is gone: those lists start at page 1.
- `$url.x = …` in a handler run by a user's event now adds a history entry (it replaced the current one before); other writes still replace it.
- `$url` writes are normalized as a reload reads them: `false` (and `null`, `''`, `[]`) deletes the parameter (`false` was written as `false`), `true` is `'1'`, a number its string.
- `sinter-embed.json` is version 2 (it lists each page's array parameters); the server layers refuse version 1: build the frontend and the server with the same release. sinter-axum's `url_params` takes the page's array parameters and returns `Param` (`One`, `List`; `as_str()`, `values()`); Sinter.AspNetCore's `SinterUrl.UrlParams` and `SlotRequest.Params` hold `UrlParam` (`Value`, `Values`; `SlotRequest.ParamValues(name)`); `@tiaforge-ui/sinter/server`'s `params` hold lists for array parameters. All three drop the names `$url` drops in the browser (`__proto__`, `constructor`, `prototype`).

### Deprecated

- `sinter({ openapi })`: give each API its spec in `sinter({ apis })` and run `npx sinter migrate` (warning `SN329`). It still works as before.

### Fixed

- `sinter check` and `sinter({ typecheck: true })` with `localePrefix`: `localeUrl()` is typed (`(locale: string) => string`) instead of failing with "Cannot find name 'localeUrl'".
- `npx sinter check` with `localePrefix`: checks each source page once, in the base language, instead of failing on the build's per-language page paths (ENOENT on `en/index.html`) and reporting `localeUrl` as SN201.
- The build reads the stylesheets of a page's layout too (a `<link>` in `src/layouts/<name>.html`): image boxes and `sizes` now follow them on pages that use a layout.
- `fonts.preload`: a family set through a custom property (`--font-sans: Inter, sans-serif` … `font-family: var(--font-sans)`, as token-based CSS like temper does) counts as used; the build no longer fails for it.

## 0.17.0 (2026-11-12)

### Added

- `sinter({ fonts: { preload } })` works for self-hosted fonts: in builds, a face no Google Fonts stylesheet has is preloaded from the page's own bundled `@font-face` (Fontsource, or your own woff2 files). The docs show how to self-host instead of loading the files from Google.

### Fixed

- A variable face (`font-weight: 400 700`, as `wght@400..700` gives) can be preloaded: a weight within its range matches it.
- `SN503` no longer warns when an `id` or `name` value starts with a literal string (`'contact-' + c.id`, `` `contact-${c.id}` ``), as its docs' fix says.

## 0.16.0 (2026-11-12)

### Added

- `$meta.<resource>.live`: the state of the server-event stream feeding a resource, `'connecting'`, `'open'` or `'retrying'` (`null` when no `<sn-event>` feeds it), the worst of them when several do. A live indicator is one binding. Reading it on a resource no stream feeds is the new warning `SN516`.
- The starter uses temper 0.3.0 (busy states show after 200ms) and its inspector (`temper({ inspect: true })`, `@tiaforge-ui/temper-inspect`). `npm run release` bumps the inspector with temper.
- `examples/dashboard`: a live service dashboard (OpenAPI-typed resource, server-sent updates, SVG graphs from bindings, temper 0.3.0) that opens on StackBlitz.

### Breaking

- The starter is `create-sinter`: `npm create sinter my-app` (was `@tiaforge-ui/create`, `npm create @tiaforge-ui`).

## 0.15.0 (2026-11-11)

### Breaking

- The instance has no `state(el)` anymore (`StateHandle` is gone from the exports). It wrote state the compiler could not
  see, so a field nothing on the page writes had been made a build-time constant and the page did not follow the
  write. State changes through handlers, models, actions and a component script's `this.state`. The dev warning for
  state changed outside sinter now says so.
- `render()` in `@tiaforge-ui/sinter/testing` compiles the page as a build does, build-time constants included (before,
  only with `firstPaint`): a test sees the built page's DOM (a constant written into the HTML, a decided `data-sn-if` as
  its branch, a constant loop as its rows), and the build's bugs show up in tests. `firstPaint` now only runs the early
  script before mounting. Its result has `state(el)` for tests; `update()` throws for a field the build made a
  constant, naming it: write it from a handler on the page.
- A build fails (`SN325`) when a page imports an app module statically that a module of the same page also loads with
  `import()`: the split did nothing for that page (Vite only warned). Import it only with `import()` there, or not
  lazily at all.

### Added

- Lazy packages ([docs/lazy.md](docs/lazy.md)). `sinter({ lazy: ['openpgp'] })` loads a package on first call instead
  of with the page: the app's imports of it stay as written and become stubs sharing one `import()`, so the package is
  a chunk of its own. Every call of its exports must be waited for (`await`, `return`, `.then`, `void`,
  `Promise.all`); anything else (`new`, `instanceof`, constants, settings, functions passed as values, side-effect
  imports, re-exports) is `SN324` at its line, in the build, in dev and in `sinter check`, and so is a helpers module
  that reaches a lazy package.
  - `data-sn-import="openpgp"` loads it when the element renders (at takeover outside templates, never before);
    `data-sn-preload="openpgp"` writes modulepreload links for its chunks into the page's head. On any element of a
    page, layout or component.
  - A component script that imports a lazy package, directly or through app modules, loads with it when its component
    first renders: `connected()` runs once both have arrived, with the latest props; an instance removed meanwhile
    never starts. The build logs each such script with the import chain.
  - `SN325`: a page's bundle or early file contains a lazy package through another package. Each page's build log line
    lists what it defers (`; lazy: openpgp 129.7 kB gzip`).
  - `$error.stale` (`SinterError.stale`): a lazy load whose chunk a deploy removed (the server answers 404, 410, or
    HTML) is a stale page, "this page is out of date: reload it", also for an `import()` of the app's in an action
    (Chromium, Firefox); the network stays `status: 0`. sinter does not reload by itself.
  - Cost: nothing for apps without `lazy`, but the call feature (pages with `data-sn-call` or `<sn-resource call>`)
    grows by 288 B gzip for the stale check of the app's own `import()`s.

- `render(html, { layouts })` in `@tiaforge-ui/sinter/testing` takes the app's layouts by name, as `components` does, so
  a page that is only a layout's tag can be tested.
- The starter template's `AGENTS.md` says where the shared markup lives (`src/layouts/app-layout.html`).

### Fixed

- A build with sinter linked into the app (`npm link`, a symlinked checkout) no longer hangs after "built in" when the
  app uses Sass: the plugin loads the app's own Vite instead of a second copy from sinter's `node_modules`, whose
  `preprocessCSS` started a Sass compiler the build never closed. Installs from npm were not affected.

- A build-time constant in `data-sn-attr` for `indeterminate`, or for `value` on a `<select>` or `<textarea>`, is no longer
  written into the HTML as an attribute, which sets nothing there (the checkbox was not indeterminate, the select showed
  its first option, the textarea was empty). The binding stays and sets the property.
- Slot content whose `data-sn-if` the build decides (a condition over a constant prop or state nothing writes) or
  whose `data-sn-for` it unrolls stays its writer's: an `emit()` in the branch is checked against the writer's
  `data-sn-emits` (not the slot's component, `SN315`), the rows see the writer's state, and both stay outside the slot
  component's scoped styles.

## 0.14.0 (2026-11-11)

### Upgrading from 0.13

- `patch('name', item, …)` → `patch(item, …)`, `remove('name', item)` → `remove(item)` (`SN317` names each one).
- `<sn-include>` → a component in `src/components/` (`SN316` lists the props it needs).
- A page without `data-sn-path` moves to its directory's index: `about.html` is served at `/about/`. Links in the
  markup follow; links built at run time to `about.html` still arrive through a redirect, but write `/about/`.
- A head with body content, or two `<title>`s, no longer builds (`SN320`, `SN321`).
- `date()` of a calendar date (`'2026-11-11'`, no time) is formatted in UTC (see Fixed).

### Added

- Components (docs/components.md): a file `src/components/<name>.html` with one `<template data-sn-component="{ …props }">`
  is the tag `<name>` on every page. Each use is expanded at build time, so a component renders in the first frame and
  costs nothing at runtime: props through `data-sn-prop` (live, read-only, checked against the declaration), slots
  (named, default, fallback content) in the caller's scope, events through `emit()` declared with `data-sn-emits`, and
  `data-sn-model` for a component with a `value` prop and a `change` event. The tag is replaced by the component's
  single root, which takes the tag's classes, attributes and handlers. The component's markup sees only its props, its
  state, resources and helpers. New diagnostics `SN312`–`SN316`; `sinter check` types props and `$event.detail`, and a
  type written in markup may name the OpenAPI spec's schemas; `render(…, { components })` in the testing module.
- Components with a script: `src/components/<name>.ts` beside the HTML extends the base class it imports from
  `./<name>.html` (`@tiaforge-ui/sinter/components`), typed by the generated `src/sinter.components.d.ts` (props, events,
  `data-sn-ref` refs by tag, state). sinter creates it per instance on its root, in rows and branches too, and runs
  `connected()`, `propsChanged()` and `disconnected()`; it reads `this.props`, writes `this.state`, uses `this.refs` and
  `this.emit()`. No custom element, no hydration: the markup is rendered by sinter, in the first frame. The starter
  template's chart is one. `render(…, { scripts })` in the testing module.
- A component may use itself (a comment thread, a file tree) when every cycle passes through a `data-sn-for` or
  `data-sn-if` template: it compiles once to a shared definition in the head, which the runtime and the early script
  instantiate per item, so a tree renders at any depth, early too. Nested items change along their path: `patch(r, …)`
  and `remove(r)` for `r in comment.replies` at any depth, and `upsert(c.replies, x)` (the `nested` module), and
  write-through applies a response to the nested item an action is about, at any depth.
- `<sn-component use="…">`: a component chosen by data, named by a template string (``use="`${b.type}-block`"``), a map in
  the markup (`use="{ hero: 'hero-block' }[b.type]"`) or a helper. `sinter check` checks the name against the generated
  `ComponentName` (a type the data can have and no component has is an error) and each candidate's props with the item
  narrowed; a value outside the candidates renders the `data-sn-else` template after it, or warns in dev builds.
- `data-sn-early="off"` on a component's tag leaves that use out of the early script, for uses that may shift the layout
  when they render later: the head script stays small.
- Scoped styles: a `<style>` in a component file goes into the page's stylesheet, wrapped in native `@scope` from the
  component's root to nested components and slot content (marked `data-sn-c` and `data-sn-s` on pages that use one).
  Each selector gets a copy whose first part may be the root (`.compact p, :where(:scope):is(.compact) p`, the same
  specificity); `@keyframes` and the other global at-rules stay outside.
- `sinter check` types custom elements from the app's declarations under `src/` (a module with `declare global` for
  `HTMLElementTagNameMap` or `SinterElementEvents`): `data-sn-prop` keys and values are checked against the element's
  properties, `$el` has the element's class, and `$event.detail` has the type `SinterElementEvents` gives the event on
  that tag (`interface SinterElementEvents { 'mail-reader': { 'reader-flag': boolean } }`).
- Heads keep every element where it is written: sinter parses the content of a page's `<head>` as template content,
  so a component's tag or a `<slot>` there no longer ends the head, and the elements after it stay in it. After
  expansion, a head holds only head elements: anything else is the new `SN320` (before, the browser moved it, and every
  head element after it, into the body without a word). `<sn-resource>` and `<sn-sync>` go in the body: in a head they
  are `SN320` too.
- Head components: a file in `src/components/` declared with `<template data-sn-head="{ …props }">` holds any number of
  head elements (`<title>`, `<meta>`, `<link>`, `<script>`, `<style>`, `<noscript>`, `<base>`, `<template>`, slots and
  other head components), inlined at its use in a head with no wrapper: an SEO component, for example. Props, slots,
  constants deciding `data-sn-if` at build time and `sinter check` work as for components; its tag takes only
  `data-sn-prop` and slot content. A head component in a body, or a component in a head, is `SN320`; head elements in a
  `data-sn-component` are `SN312` with the hint to declare it with `data-sn-head`.
- Layouts: a file `src/layouts/<name>.html` is a whole document whose `<html data-sn-layout="{ …props }">` declares its
  props, with any number of slots in its head and body. A page that is only the layout's tag gets the layout's
  document: the tag's content fills the slots (head elements with `slot="…"` for a head slot), its attributes go onto
  `<html>` (replacing the layout's: `lang`, `data-sn-path`; `class` is joined), its handlers onto the layout's `<body>`
  (DOM events, `sn-error` and `dismiss`: the page's `<body>` handlers), and `data-sn-state` on it is the page's
  state, which the props and the slot content see and the layout does not. The merge happens before anything else
  reads the page, so the early scripts, preloads, embedded data, Google Fonts and Vite's bundling of the layout's
  scripts and stylesheets work on the merged head. The layout's relative URLs are relative to its file. New
  diagnostics `SN318` (an invalid layout), `SN319` (a page that is more than the tag, a layout tag anywhere else) and
  `SN321` (a second `<title>`, `<meta name="description">`, `og:title`… in the head, on every page: a page that has
  two `<title>`s, which browsers tolerate, no longer builds).
- Slot forwarding: a `<slot>` that is itself slot content of a component's tag (`<seo-tags><slot name="seo"
  slot="extra"></slot></seo-tags>`) passes what fills it on into that slot, with its fallback when it is left empty.
  Slot content keeps its first caller's scope through any number of components (before, content a component passed
  on into another component's slot took the scope of the component in between).
- Head bindings: a `<meta>` with a literal `name`, `property` or `itemprop` binds its `content`
  (`data-sn-attr="{ content: … }"`), for a per-page description or `og:title`; every other binding on a `<meta>`, and
  any on `http-equiv` or `charset`, stays `SN207`. With `<title data-sn-text>` and `data-sn-if` templates over head
  elements, what needs no request (constants, helpers, embedded data) renders as the head is parsed.
- Types and editors for layouts: `src/sinter.components.d.ts` has `LayoutName` and `LayoutProps`, and leaves head
  components out of `ComponentName`. `sinter check` checks a layout's props at the page's tag and its markup through
  each page. `sinter lsp` completes `slot="…"` with the slots of the tag the element is in (a layout's head slots on
  head elements, its body slots on the rest), completes tags after `<` (layouts at the top of an empty page, head
  components in a head, components elsewhere), goes from a `slot="…"` value to its `<slot>` and from a layout's tag to
  its file, shows a tag's props and slots on hover, and checks a layout or head component no page uses on its own.
- docs/layouts.md; the RealWorld example's seven pages share one layout and a `conduit-seo` head component, with the
  HTML, head scripts and page modules level (docs/realworld-comparison.md, Layouts).
- Pages without JavaScript (docs/static-pages.md): a page with nothing left to run in the browser gets no script at all,
  no page module, no early script and no runtime, and links its components' and images' stylesheets instead. A site
  built from a layout, components and text ships no `.js` file; on a mixed site only the pages that need the runtime
  load it. The build prints one line per page: `no JavaScript`, or the page's and the shared chunks' size (gzip) and the
  first few things that run, where they were written. `sinter({ static: ['about.html', 'docs/**'] })` (or `true`) lists
  pages that must stay so: one that needs the runtime is `SN322` at each cause, in the build, `sinter check` and the
  editor, and a pattern that matches no page fails the build. On such a page the app's global modules (the config
  module and the early module) do not run, and next-page data is not prefetched (Speculation Rules still are); a script
  the page or its layout writes ships as written, a plain module script.
- Canonical URLs (docs/static-pages.md#canonical-urls): `sinter({ site: 'https://example.com' })`. Every page whose URL
  is known gets `<link rel="canonical">`, and expressions get `$site` (the origin and Vite's `base`) and `$canonical`
  (the page's URL), build-time constants on a page with a fixed path (`og:url`, `og:image` in a head component, with no
  JavaScript). A page's own canonical link must be absolute and becomes `$canonical`. On a page whose path is a
  pattern, `$canonical` and the page's canonical link are written by the early script from the address, when the
  page ships JavaScript anyway. Without `site`, `$site` and `$canonical` are the new error `SN323`.
- Languages in the URL (docs/static-pages.md#languages): `sinter({ localePrefix: true })` builds each page once per
  language of the inlang project, under its prefix (`/en/about/`, `/de/about/`), with `<html lang>` and that language's
  messages and `$locale` written into the HTML, in attributes too, so a page with nothing else to run ships no
  JavaScript in any language. A page that runs loads no language file or picker: the messages its code needs are
  compiled into its script, and those the app's modules call are written into the page. `number()`, `bytes()` and
  `date()` of a calendar date over constants are written at build time. `localeUrl('de')` gives a page's URL in another language; links to the app's pages stay
  in the page's language; `data-sn-path` is written without the prefix. With `site`, each page gets `hreflang` links and
  `x-default`. Each unprefixed URL is a language chooser: the base language without JavaScript; on a site that ships
  JavaScript, the `locale` cookie its pages set, else the browser's languages. `_redirects` has each language's rules
  and the choosers'; sinter-axum answers an unprefixed URL with a 302 to the visitor's language; `vite dev` serves it
  all. `baseLocale` must be set and among `locales`. Assigning `$locale` in a page built in one language is `SN203`.
- A binding written into the HTML at build time that reads nothing that can change (a literal, a component prop given as
  one, a state field nothing on the page writes) is left out of the page module, with its function and, when nothing
  else is bound there, its node and `data-sn` id.
  A dependency on a state field nothing writes is left out of every binding (in rows and branches too): the runtime
  subscribes to nothing for it.
  Inside templates, such a binding is written into the template's markup and left out, and a state field nothing
  writes or reads anymore leaves the state. A `data-sn-if` over state nothing writes is decided at build time: its
  branch, or its `data-sn-else`, is page markup.
- A `data-sn-for` over a constant list (a literal, a prop given as one, state nothing writes) whose rows read only the
  item, its index, constants and such state is unrolled at build time: its rows are in the HTML, also with JavaScript
  off, and the page module carries no template for them. Before, a component's nav or footer list built from a
  constant prop was empty until the page module ran. Rows with a handler, model, state or nested loop stay templates.
- A page-level `data-sn-state` none of whose fields are left (nothing writes or reads them) has no node in the page
  module and no `data-sn` id.
- The early script renders bindings that read `$url` (its query and `data-sn-path` parameters) on every page, so the
  current nav item or a tab chosen by the URL is right in the first frame; before, only on pages with embedded data.
- RealWorld is built with components: header, footer, article meta, byline, preview, error list and one favorite
  button for the feed, the profile and the article page.
- The starter template (`npm create @tiaforge-ui`) shares one layout, `src/layouts/app-layout.html`: the head, the
  header, the frame and the toast region, and the "fail next change" state, which is the layout's now. Each page is
  the layout's tag; the task page's tab title is the task's.
- User guides for every part, linked from the README: resources, pagination, sync, actions, components, layouts,
  static pages, navigation, first paint, configuration, type checking, testing, security and islands, and
  docs/attributes.md, a reference of every attribute generated from the source.

### Removed

- `patch('name', item, …)` and `remove('name', item)` (breaking): `patch(item, …)` and `remove(item)` act on the item
  in the resource it came from, found by its key: a loop row (also of a `?:` between lists, of `filter`/`toSorted`, of a
  helper given one resource), an element (`list[0]`, `.find(…)`), a single resource (`remove` makes it `null`), a
  component prop or emitted detail that is one, or state a handler assigned one (`sel = m`, `structuredClone(m)`). Drop
  the first argument; the old forms and an item with no source fail with `SN317`.
- `<sn-include>` (breaking): a partial is a component. The build fails with `SN316`, whose message lists the names the
  partial reads from the page (the props it needs). `SN305` is retired; `SN306` is now a component that uses itself
  with no `data-sn-for` or `data-sn-if` template between. The starter template's header and RealWorld's partials are
  components.

### Changed

- Page URLs (breaking; docs/static-pages.md#page-urls): every page without `data-sn-path` is written as a directory's
  index, `about.html` as `about/index.html`, served at `/about/` on any static server without configuration (it
  redirects `/about` there). `about.html` remains as a redirect to `/about/` (a refresh with a canonical link and
  `noindex`, and a script that keeps the query and fragment), so old links arrive. Links in the markup to a page, by
  its file or its URL, are written as its URL; a moved page's relative URLs are rebased. `index.html`, `404.html` and
  `200.html` stay. A page with `data-sn-path` answers at exactly the paths it lists, with or without parameters
  (`/article/:slug`, `/ /tag/:tag`, `/login`), and stays in its file; a pattern also matches with a trailing slash; a
  `data-sn-path` that is only the page's directory URL is the new warning `SN515`. The build writes `_redirects`
  (Netlify, Cloudflare Pages), after the app's `public/_redirects`: a 301 for each old file URL and a rewrite for each
  declared path; `sinter({ redirects: false })` turns it off. `vite dev` (which now finds every page under the root, with no build input), `vite preview` and sinter-axum (from
  the manifest's new `routes`) follow the same rules, so RealWorld's hand-written routes are gone. Two pages for one URL
  fail the build; a link built at run time that names a moved page's file is a build warning. The starter template's
  task link is `/task/?id=…`.
- Changes from server events render once per frame: `<sn-event>` mappings and their `then` still apply when each
  event arrives, but the render waits for the next frame (`requestAnimationFrame`), so a burst renders once. Other
  changes still render in a microtask, taking waiting server changes with them; a hidden page renders server events
  in a microtask. Measured on a live dashboard (bench/live, 4× CPU slowdown): it kept up with 200 events/s before,
  5,000/s now (51 fps); Datastar's signals mode keeps up with 200/s.
- Lists: swapping two rows (the ends of the changed middle traded places, the rows between unchanged) moves the
  two rows without building a key map or a longest increasing subsequence (js-framework-benchmark's swap: script
  0.9 → 0.4 ms).
- A text binding writes a non-zero number into an element without content as it is, for the DOM to convert, instead
  of converting it in JavaScript, which filled V8's number-to-string cache (64 KB after creating 1,000 rows).
- Testing: `render(…, { frames: true })` and `frame()` to test what waits for the next frame (without `frames`, server
  events flush in a microtask as before).
- Heads are checked (breaking for a page whose head holds body content or two of one element): body content, or
  `<sn-resource>`/`<sn-sync>`, in a head is `SN320`, and a second `<title>`, description or `og:title`… is `SN321`
  (both under Added).
- sinter-axum is released with sinter, at the same version.

### Fixed

- `date()` of a calendar date (`'2026-11-11'`) showed the day before for visitors west of UTC: it is now formatted in
  UTC, where it was parsed. A moment (with a time) is still shown in the visitor's time zone.

## 0.13.1 (2026-11-10)

### Fixed

- Rows over embedded data whose nested `data-sn-if`/`data-sn-else` or `data-sn-for` the early script had rendered:
  the page module's element lookup counted the nodes the early script inserted after a nested template as the
  row's own, so an `else` branch never rendered (its template was not found) and bindings on elements after a
  nested template were lost. Adopted rows now step over those nodes, and a removed row takes them with it.

## 0.13.0 (2026-11-10)

### Added

- `sinter({ embed: true })`: builds for a server that writes each page's data into it. Every resource whose request
  only the page's URL decides gets a data placeholder (not `call`, `each` or `early="off"`), and is neither preloaded
  nor requested early. `sinter-embed.json` describes simple `when` conditions (`$url` values against strings, `!`,
  `&&`, `||`) and `start-page`.
- RealWorld: marked and DOMPurify load with the article page again (its LCP is the Markdown body: 1,088 → 888 ms on
  slow 4G with sinter-axum). The size check leaves the example's own dependencies out of the page budgets and
  reports them apart.
- Pagination: `offset-param` in offset mode (the items to skip instead of the page number), and `start-page`
  (offset mode, or keyset with `offset-param`): the page the first load asks for, e.g. `start-page="$url.page"` for
  lists whose page links navigate. RealWorld's lists use both instead of its `offset()` helper.
- sinter-axum: a page whose data cannot be fetched ends, still streamed, with an error text (or a redirect to an error
  page); unstreamed, with a real 502/504. The runtime does not mount on such a page (`<body data-sn-failed>`, a
  marker the server writes, not an attribute for pages).
- sinter-axum: `build()` checks that every placeholder has a source (a resolver, `skip`, or a request it can make)
  and lists every problem; `embed!` makes that check when the server compiles and compiles the manifest in.

- `packages/sinter-axum`: a Rust `tower` layer (axum) that fills a build's `data-sn-data` placeholders per
  request. It streams the head up to the first placeholder at once, then each placeholder's data from the app's
  API router (in-process), an upstream or an allowed origin (both with the opt-in `upstream` feature, which
  adds reqwest), or a resolver function. RealWorld, slow 4G: home LCP
  948 → 588 ms; one core serves about 2,000 home pages/s, against 57–67 for Qwik City
  (docs/first-paint-comparison.md).
- Builds with embedded-data placeholders write `sinter-embed.json` next to the pages: each page's paths and,
  per placeholder, its `data-sn` id, resource and request (the `src` template when only `$url` reads make it up;
  for a paginated resource, its first page).

- Bindings over embedded data render before the first paint: on a page whose `<script type="application/json"
  data-sn-data>` a server filled in, the early script also renders the bindings that read those resources,
  `data-sn-for` rows included, and `$url`, as the parser goes. The page module adopts the rows (binds them, no
  second render). A server (a middleware) only has to fetch the API and write its JSON into the page; no DOM,
  no server rendering. Measured against Qwik City in docs/first-paint-comparison.md.

- `sinter({ fonts: { preload: [...] } })` (opt-in): preloads faces of the Google Fonts the pages link
  (a family for its regular face, or `{ family, weight, style }`), their Latin file, in builds and dev.
  The build fails when a page preloads a family none of its stylesheets uses, or a face no page has;
  dev warning 25 when the page did not render with the face in its first 3 frames.

### Changed

- An empty `data-sn-data` placeholder is no data: the page requests the resource, with no dev warning (was
  warning 5, "not valid JSON"). It is what a server leaves when it has nothing to write.

- First paint no longer holds the paint (PR #16). The early file is a classic script first in the head (one
  shared by every page, `assets/sinter-head-<hash>.js`, and the page's own, `assets/<page>-head-<hash>.js`)
  that renders each early binding as the parser inserts its element (a `MutationObserver`). Gone: the
  render-blocking early module (`blocking="render"`), its split `async` file and stub, the chunk it shared
  with the page bundle, the Firefox fallback that hid `<html>` (`sinter-paint-<hash>.js`), and the blocking
  language file. RealWorld, Chromium on slow 4G cold: first paint 564 → 508 ms (home), 544 → 484 ms
  (article), no wrong frame in 240 loads either way; Caley's persisted rail collapsed in the first frame in
  Chromium and Firefox. `vite dev` works the same way.
- Messages: the language file is not waited for. The base language's text is in the HTML (`data-sn-m`);
  for another language those elements are hidden, their space kept, until the page module has rendered
  them (3 s at most), so nobody sees one language replaced by another.
- The early script writes an element's attribute-like bindings (`attr`, `class`, `style`, `show`) when the
  parser inserts it, and its content (text, a control's value, `if`, `for`) once the parser has closed it.
  Before, a persisted class on an element that wraps the page waited for the end of the document.
- One classic head script per page: a page that uses `data-sn-transition` and has an early file or
  messages gets the hold script and the paint script (or the language picker) in one file,
  `assets/sinter-head-<hash>.js`, instead of `sinter-hold-<hash>.js` plus the other: one parser-blocking
  request on the first paint's path, not two. Pages with only one of them keep their file as before.
  RealWorld's home page, real Chrome throttled to slow 4G and 4x CPU (median of 7): first paint 564 → 496 ms.
- Smaller builds: the core is 14,606 → 13,514 B gzip, the minimal page 14,787 → 13,691 B; RealWorld's
  pages 2.4–3.5 KB smaller each (the article 27,627 → 25,251 B of its 27,648 B budget, login 23,947 →
  20,814 B), their early files 1.0–1.9 KB (were 2.3–3.4 KB). Measured with Lighthouse (mobile, a fixed
  API) where the first paint's path changed: no change in FCP or LCP. The entries below give each step's
  numbers at the time.
  - Form serialization and `data-sn-encoding="form"` moved from the core into a feature module
    (`@tiaforge-ui/sinter/form`, 0.8 KB gzip), imported only by pages with a form action without
    `data-sn-body` (not GET or DELETE) or with form encoding: core −390 B. `serialize` and `formBody` are
    exported from `src/form.ts` instead of `src/runtime/app.ts`.
  - The selection index (`{active: row.id === selected}` in a row: only the rows that were and become
    selected re-render) moved into `@tiaforge-ui/sinter/select` (0.5 KB gzip), imported only by pages with
    such a binding: core −214 B. Selecting a row in a 5,000-row list is unchanged (0.009 ms, happy-dom; the
    runtime benchmark has the case now).
  - Writing `$url` from a handler (the query string follows, `replaceState`) moved into
    `@tiaforge-ui/sinter/location` (0.3 KB gzip), imported only by pages whose handlers write `$url`:
    core −96 B.
  - Action functions' runtime part (`data-sn-call`, `<sn-resource call>`: the call context, the pagehide
    signal, a thrown value as `$error`) moved into `@tiaforge-ui/sinter/call` (0.4 KB gzip), imported
    only by pages that call one: core −127 B.
  - Debounced handlers and actions (`data-sn-debounce`, `data-sn-debounce-<event>`) moved into
    `@tiaforge-ui/sinter/debounce` (0.2 KB gzip), imported only by pages with one: core −67 B.
  - `data-sn-confirm` moved into `@tiaforge-ui/sinter/confirm` (0.2 KB gzip), imported only by pages with
    one: core −38 B. `config.confirm` is `null` unless configured (the browser's `confirm()` is used
    then, as before).
  - Models of controls other than text fields (checkbox, radio, `<select>`, number and range) and the
    `<select>` value set again after each render moved into `@tiaforge-ui/sinter/models` (0.5 KB gzip),
    imported only by pages with one: core −168 B. Text fields and textareas stay in the core.
  - The URL check reads the scheme as the URL standard does (`schemeOf`: leading controls and spaces
    stripped, tabs and newlines removed, a letter then letters, digits, `+`, `-`, `.` up to `:`) instead
    of `new URL()`: 0.06 µs per URL instead of 0.74 µs in Chromium; the same decision as the browser's
    parser on every URL it parses (200,000 generated strings in Chromium, 50,000 against Node's in the
    tests). A relative URL is judged by the base of the document it is written into, which a
    `<base href>` can make another scheme (an `ftp:` base makes relative links `ftp:` links: refused),
    where the core used the document's URL whenever the base was not http(s); not by the element's own
    base, which is `about:blank` while a row is a clone of its template. Only the scheme is checked: a URL
    the browser cannot parse further is written, an invalid link as in static HTML. Core +51 B.
  - Early requests read the browser's clock, location and fetch unless the app has an early module
    (`src/sinter.early.ts`), the only code that could `configure({ env })` before the first paint; then
    the compiler passes `configured` to `requests`, and only then does the early file carry the config.
    RealWorld's early files with requests −135 B gzip (1.7–1.9 KB). RealWorld's `signedOut` helper reads
    a standalone `getToken`, so the early files no longer carry the whole `token` object (−28 B).
  - The dev warning for duplicate `data-sn-for` keys moved into the dev module: core −43 B.
  - The Vite plugin turns off Vite's modulepreload polyfill unless the app sets `build.modulePreload`'s
    `polyfill` (or `modulePreload: false`): every browser sinter's pages need preloads modules natively.
    RealWorld's pages −212 B each.
  - RealWorld: `<conduit-markdown>` moved from the islands every page loads into `src/markdown.js`, loaded
    by the article page only. Its dynamic imports of marked and DOMPurify brought Vite's preload helper
    (~600 B gzip) into every page: the other pages −814 B each, the article +214 B (the helper is in its
    own chunk now). The article requests the renderer when the module runs, alongside its data, instead
    of once the data has arrived.
  - Early files no longer carry their own copy of URL expansion (and, where an early binding needs
    them, the URL checks): the build emits what some early file uses as one chunk the early files and
    the page bundle import, preloaded with each early file that uses it; an early file with no early
    request and no checked attribute or style imports nothing. `BAD_KEY` and `$k` moved to
    `runtime/keys.ts`, `encodeSegment` to `runtime/url.ts` (`security.ts` re-exports the first two).
    Each RealWorld early file is 0.3–0.8 KB smaller (also when following a link to another page); per
    page, the article, index, profile and editor about −380 B, login, register and settings about
    +110 B (their early files used little of that code). Lighthouse (mobile, fixed API): no change in
    FCP or LCP. The early file's size report and budget include the shared chunk.
  - The early file's bindings are compiled (`src/compiler/early-render.ts`): instead of the early IR and
    the runtime that interpreted it, the early module holds the page's renderer as straight-line calls
    of small writers and helpers that `@tiaforge-ui/sinter/early` exports, so each early file bundles
    only the writers its bindings use, and the clock, location, fetch, storage and `config` only when
    its requests, persisted state or `$locale` need them. An attribute that is no URL attribute, or a
    URL whose expression fixes its scheme (`'/article/' + slug`, `` `#${id}` ``, `x ? '/a' : null`), is
    written without the browser's URL check, which checks only the scheme. A lone leading `/`
    (`'/' + v`, `` `/${v}` ``, also `'//'`, `'/\'`) does not count: `v` starting with `/` or `\` makes
    it `//host`; those keep the check (docs/spec.md, URL attributes). A page with nothing to wait for (no early request, no
    messages) renders in one step (`run(page)`). RealWorld's early files 1.0–2.0 KB gzip (were
    2.0–3.4 KB); login, register and settings import nothing. Each page 700–900 B smaller (login
    22,364 → 21,254 B, the article 26,578 → 25,810 B). The early page object is
    `{ ir: { res, path }, fns, scopes, render, locale? }`; `early(doc, page)` (tests) takes it,
    and `earlyPage(parts)` from the compiler writes its source. `compactEarly` is gone.
  - The page module imports feature modules as `sn$<name>`, so a helper named like a feature (`keys`,
    `form`, …) no longer collides with its import.

- IR v2: the page module's dependency and written paths are node ids of one trie per page, with a path table
  (`ps`) in place of the strings; the compiler decides which written path reaches which binding and leaves the
  runtime only the checks against scope values (`src/paths.ts`). The runtime refuses IR v1. The compiler's IR
  (`compileParts().ir`) keeps its strings; pass it through `compactIR()` before `mount()`. Feature modules
  receive dirty paths as `{ w, v }` (a node and its `{name}` values) and test a state scope with `inState()`
  from `src/paths.ts`; `app.mark()` takes a node, or one of the paths the runtime marks by name. Saving a
  persisted state object after a change moved from the core into the persist module.
- Writes through a row's own element (`rows[i].v = …`, typing into `data-sn-model="rows[i].v"`) reach that
  row only: the runtime no longer checks every row of the list. A keystroke in one row of a 20,000-row state
  list: 2.9 ms → 0.006 ms, the same as in a 10-row list (runtime benchmark, happy-dom); a handler writing
  one field among 5,000 root bindings: 0.39 → 0.10 ms; an island's `update()` on that page and a server
  upsert into a 5,000-row list are unchanged. Sizes, gzip: the minimal page +410 B (14,787 B of its
  15,360 B budget); RealWorld pages about +500 B each (the article 27,627 B of its 27,648 B budget). The
  path table compresses less well than the strings did, which shared their bytes with the function table.

### Added

- Source maps for the page module: an error thrown in a markup expression points at its attribute in the HTML
  (or the partial it came from) in the browser's devtools. `compile(html, { sourcemap: true })` returns `map`
  for the page module and `earlyMap` for the early module, mapping each function in `fns` to where its
  expression starts; the module text is unchanged. The Vite plugin uses them in `vite dev` and in builds with
  `build.sourcemap`.
- Dev builds name the attribute an expression threw in, and pass the error on, so its stack shows: `binding
  \`text\` on <p> at src/inbox.html:12:20 threw: …`, `model on <input> at … could not be set: …`, and
  `handler at … threw: …` for `data-sn-on-*`, an action's `then`/`catch` and a resource's or event's `then`
  (still each time it throws). Each use is named, although identical code is one function in the page's table:
  the dev IR carries the place of each binding's, action's, resource's and event's functions (`at`). Production
  IR is unchanged; the core is 17 B smaller minified and 8 B larger gzip.
- Server errors on a form: a mutation without `data-sn-catch` on a form, or on a button or control inside one
  (a `type="button"` Publish), that fails with a 4xx and `{ errors: { email: "…" } }` (or `email: ["…", "…"]`)
  marks the control with that `name`: `aria-invalid="true"` and the message in the element its
  `aria-errormessage` names, else in a `<small data-sn-error data-tone="danger">` inserted after it; the first
  such field gets focus; editing a field clears its error, sending again clears all. Inside the form,
  `$error` is its last failed send (or `null`), for any binding: a summary or a 5xx's `detail` is plain
  markup. Shown (no `sn-error`, no `onError`) when every message marked a field or the form reads `$error`.
  `data-sn-catch` opts out. Other formats: `configure({ fieldErrors: (error, { url, method }) => ({ name:
  messages }) })`, reading the server's messages from `error.body` (or mapping error codes to `m.key()`);
  `null` marks no field, `undefined` leaves it to the default. A feature module (`fields`, 1.1 KB gzip), loaded only by pages with such an action or a form that reads `$error`. Recipe: `docs/recipes/field-errors.html`.
  The create template's task forms use it.
- `refresh="30s"` on `<sn-resource>` (`@tiaforge-ui/sinter/refresh`): the resource is reloaded in the
  background once its last load is that old, counted from every load (first load, `refresh()`, a
  `refetch` event, a reconnect, a `src` change), so next to a stream it is a check that fills in only when
  the stream has gone quiet. `$meta.loading` stays false during a refresh; nothing is reloaded while the
  page is hidden (a refresh that fell due runs when it is shown) or while `when` is falsy; failures back off
  up to 30 s and are reported once until a load succeeds. At least `1s`, else `SN401`.
- Unchanged reloads: a reload whose response carries the `ETag` (else `Last-Modified`) of the response the
  data was last replaced with, while nothing has changed the data since, is not parsed or stored and nothing
  re-renders; `then` runs with the `$result` of the load that stored the data, and `loadedAt` moves, as for
  any load. For every reload of a `src` resource on pages
  with `refresh` or `<sn-sync>`, where the compiler adds `@tiaforge-ui/sinter/versions`; a `304` that reaches
  the page counts the same. The browser's HTTP cache does the
  revalidation when the server sends `Cache-Control: no-cache`.
- `@tiaforge-ui/sinter/testing`: `visibility('hidden' | 'visible')` on a rendered page.
- Retry policies (`@tiaforge-ui/sinter/retry`): `configure({ retry: retry({ policies, get }) })` names
  policies (`backoff: [first, longest]`, `retries`, `maxAge`, `key`), and `data-sn-retry="drafts"` on a
  mutation sends it again as that policy says: after a network error once the session probe answers 2xx (a
  401 ends it), after a 5xx, after a 429 or 503 not before `Retry-After` (at once a failure when that is
  after the policy's last try); a retried `DELETE` that gets 404 succeeded. Each trigger sends one
  `Idempotency-Key` on every try. While it waits the element stays `aria-busy`, its optimistic change stays,
  `latest` replaces it with a newer trigger, and leaving the page asks first (`beforeunload`). `get` is the
  policy of every GET except background refreshes. Bare `data-sn-retry` is `SN401`; on a GET, a
  `data-sn-call` or an element without an action, `SN102`. The module is 1.7 KB gzip, in the config
  module's bundle only; core +39 B. Guide: `docs/retry.md`; recipe: `docs/recipes/offline-draft.html`.
- `@tiaforge-ui/sinter/testing`: `window('beforeunload', props)`; `settle()` does not wait for a request
  waiting between retries (`advance(ms)` moves to its next try).

### Changed

- **Nothing is sent again unless a retry policy says so.** The request layer sent GET, HEAD, OPTIONS, PUT
  and DELETE once more after a network error; without `retry.get` a failed load now sets
  `$meta.<name>.error` at once, and recovers on `online`, a stream reconnect, a refresh or `refresh()`.
  Stream reconnects, the session probe and those reloads are unchanged. An early request that failed (a
  network error) now fails its load as well; with `retry.get` the policy's next try is a real request.

### Changed

- The IR in a page module carries only what the page sets. Actions leave out `body`, `debounce`,
  `optimistic`, `then`, `catch`, their write paths and `form` when absent, and `trigger` is gone (the `on`
  binding has the event); resources leave out null fields, empty `deps` and `scope: -1`; stream events
  leave out null fields; nodes leave out `p: -1` (no enclosing state scope), in the early file's IR too;
  templates leave out a null `index`, `key` and `keyFields`; a page without streams has no `syncs`
  (`compactIR` and `compactEarly`, also what `render()` and `firstPaint()` run). An attribute the page does
  not write costs no bytes: the minimal page is 39 B gzip smaller, RealWorld's pages 71–97 B. IR with every
  field spelled out still runs (still `v: 1`).

### Fixed

- A failed form action without `data-sn-catch` threw instead of dispatching `sn-error` under happy-dom
  (tests with `render()`), which wraps forms in a Proxy that `EventTarget.prototype.dispatchEvent` refuses
  as receiver. Browsers were not affected.

## 0.12.0 (2026-11-09)

### Added

- `npm create @tiaforge-ui` (`packages/create`, released with sinter): a new app with sinter and temper, a
  task board on a demo API that runs inside Vite (`server/api.js`). It shows a typed resource with `cache`,
  `<sn-sync>` updates across tabs, optimistic changes that roll back ("Fail next change" makes the server
  refuse one), a form dialog, a key filter, `data-sn-persist`, an island (a canvas chart: `data-sn-prop` in,
  a `CustomEvent` out), next-page data and a page transition, and `typecheck: true` with temper's Vite
  plugin; its README lists typos that fail the build. `npm run release` bumps its version and the sinter
  version new apps get; its test builds the template with temper (a devDependency).
- Early requests of paginated resources (`paginate="keyset"`, `"offset"`, `"append"`): a resource whose
  `src` and `when` qualify for an early request (they read only state that needs no data, persisted
  values, `$now`, `$url` and helpers) is requested by the early file at its first page, with exactly the
  query parameters the pager sends for it (`size-param`=`page-size` and `direction-param`=the `first` value
  of `direction-values`, or `page-param`=1 in offset mode; no cursor), and the runtime's first load takes
  that response, as for other early requests (a request that differs is sent by the runtime). `$meta`
  (`total`, `hasNext`, `from`/`to`, …) is as after any first load; with `cache` the cached page shows at
  once and the early response revalidates it. A paginated resource with a literal `src` and no `when` is
  preloaded from the HTML at its first page. Only a page with such a request carries the parameter code in
  its early file. `each` and `call` resources stay out.

### Removed

- The chunk policy of 0.11.0 (`sinter({ chunks })`: small shared chunks copied into the pages, sinter's
  runtime as one shared file) is gone; builds use Vite's chunks again. Measured on Caley over HTTP/2 + TLS +
  gzip, as a reverse proxy serves it (cold loads, 40 and 300 ms round trips, median of 5): Vite's chunks,
  the 0.11.0 default, copying without the runtime file, one bundle per page and one bundle per page with a
  shared runtime all painted and showed content within 15 ms of each other. Vite's shared chunks already hold
  only what the pages using them need; merging only saved requests, which HTTP/2 makes cheap, and added bytes
  (one runtime file with every feature: 8-11 kB gzip more on light pages; module wrappers from the forced
  execution order). It helped only over HTTP/1.1, which a reverse proxy fixes for every app, and it relied on
  an experimental Rolldown option and a rewrite of the build output. `chunks` is no longer an option of
  `sinter({ … })`: TypeScript reports it, the build ignores it; remove it.

### Fixed

- A list sinter cannot trace to a resource (a helper's result: `t in visible(tasks, q)`) re-created a row
  on every patch of its item: it keyed rows by object identity, and a patch replaces the object. Items that
  are a keyed resource's current items now keep their rows by the resource's key, so focus stays and an
  action's error reaches the page.
- An action's `sn-error` from an element no longer in the page (its row went with an optimistic `remove`,
  then the server refused) reached no `data-sn-on-sn-error` handler; it now bubbles from the element's
  nearest ancestor still in the page.

## 0.11.0 (2026-11-09)

### Added

- Chunks of multi-page builds (Vite 8): shared chunks below 10000 bytes of code are copied into the
  pages that import them, so a page loads fewer files (Caley's mail page 20 → 11 files, 300 ms
  earlier at a 300 ms round trip); sinter's runtime and what every page loads are one
  `assets/sinter-<hash>.js`; large shared chunks stay shared and lazy chunks lazy. The build runs
  module bodies in source order (`strictExecutionOrder`, a little code per module) and builds the
  helpers and actions modules as side-effect free. `sinter({ chunks: { minSize, runtime } })`,
  `chunks: false` for Vite's chunks.

### Fixed

- Next-page data: resources of the next page that read different parts of one response (same
  `src`, different `items`, such as a contacts list and its addressbooks) share one request, as they
  do on the page itself. Before, each sent its own.
- The build's Speculation Rules hint said the default delivery is by a response header; it is
  inline. The hint now says that nothing is needed without a CSP and that a CSP sent as a response
  header needs `'inline-speculation-rules'`, and it is left out when every page has a CSP
  `<meta>` (the build adds the hash there).

## 0.10.0 (2026-11-09)

### Added

- `sinter({ origins: [...] })`: every page adds these origins to the runtime's allowlist (list API
  origins once, here, instead of in `configure({ origins })`), and resources whose `src` names one
  are preloaded or requested before the page module like same-origin ones, without credentials.
  The build names origins it left to the page module.
- A page with early requests loads its early file `async` before the stylesheets, so its requests
  leave while they load, and renders it from a small render-blocking stub
  (`assets/<page>-render-<hash>.js`). Pages without early requests and `vite dev` are unchanged.
- `<sn-resource early="off">`: no preload and no early request for that resource (one a request
  middleware answers itself or adds a header to).
- Google Fonts inlined at build time (on by default; `sinter({ fonts: { inline: false } })`): a
  `fonts.googleapis.com` stylesheet link becomes one of the app's CSS files, with a preconnect to the
  font files' origin. Same fonts and look; cached in `node_modules/.cache/sinter/fonts`, an offline
  build keeps the link and warns.
- Image sizes: a percentage of a parent with padding or borders resolves to its content box (with
  `box-sizing: border-box`, the width less padding and borders), from longhands, logical
  properties and shorthands: an `<img>` at `width: 100%` in a 300 px card with `padding: 16px` is a
  268 px box. Before, any padding or border on the parent left the image fluid.
- Fluid images: `sizes` is the image's width at every viewport width, from the page's CSS: per range
  between its width media queries, linear in the viewport (`calc(50vw - 32px)`), split where a
  `min()`, `max-width` or centred container meets the viewport. Grids (equal tracks with gaps,
  `span`, `repeat(auto-fill, minmax(200px, 1fr))` with a split at every column count), flex rows
  (equal `flex: 1` columns, wrapped items with a basis), margins, padding, borders and the
  browser's default margins resolve. A 3-column grid from 768 px gets
  `(max-width: 479.98px) calc(100vw - 48px), (max-width: 767.98px) calc(50vw - 32px), calc(33.33vw - 26.67px)`
  instead of `100vw`; an image 40 px on phones and 64 px above gets exactly those files. Checked
  against Chromium at 17 viewport widths. Static and API images; the upper bound stays the fallback.
  An unbounded `auto-fill` grid is split until its tracks vary by at most 15%, then one width.
- Warning `SN514 auto-fit-rows`: an image in the rows of a `data-sn-for` in a `repeat(auto-fit, …)`
  grid, whose width depends on the number of rows; `auto-fill` gives it exact sizes.
- Dev: the console warning for images that look soft also checks CSS backgrounds: the file the
  browser uses (`url()`, or the `image-set()` option it picks), drawn at the width
  `background-size` gives it (`cover`, `contain`, lengths, `%`, `auto`), also for elements added
  later, and on `::before`/`::after` (a hero image on an overlay) at their computed size. For a
  sinter-built `image-set()` it names the source width the 2x rule needs.
- Static images (docs/images.md): every `<img src>` of a local JPEG, PNG, WebP or AVIF in a page or
  partial becomes a `<picture>` with nothing written for it. Photos get AVIF with a JPEG fallback,
  PNG graphics lossless WebP with a PNG fallback (a PNG that is really a photo gets AVIF), sources
  under 4 KB stay as they are. Fluid images get widths 480 to 2560 up to the source's; `width`/
  `height` smaller than the source are a box, with files of exactly 1x, 2x and (boxes up to
  300 × 300) 3x its width. Inline `object-fit: cover` crops the file at `object-position` and the
  style is removed; `contain` makes the fitted size. Every image gets `width`/`height`,
  `decoding="async"` and, except the page's first, `loading="lazy"`; a generated stylesheet in the
  page's CSS gives it `height: auto` and its dominant color as background until it loads. Dev
  encodes a variant on its first request, builds emit them to `assets/`; both cache by content
  hash in `node_modules/.cache/sinter/images`. Warnings `SN511 image-too-small` (a box the source
  cannot fill at 2x) and `SN512 image-stretched`. sharp is an optional dependency;
  `sinter({ images: false })` turns it off, `images: { widths }` sets the fluid widths.
- Image sizes from the page's stylesheets: an image the CSS gives a fixed width (and height or
  `aspect-ratio`) is a box with exact files, cropped when the CSS says `object-fit: cover`, with no
  attributes and no knowledge of the CSS framework: an `<img>` in temper's `[data-avatar]` gets
  40/80/120 px squares. A cascade over the page's `<link>`, `<style>` and imported CSS (layers,
  specificity, `!important`, nesting, custom properties, `calc`/`min`/`max`/`clamp`, px, rem, % of
  a fixed parent); anything that depends on layout, a media query, a state or a binding leaves the
  image fluid. Checked against Chromium's layout in the tests. Each stylesheet is read as Vite
  outputs it (`preprocessCSS` with the project's config): Sass, Less, Stylus, PostCSS plugins.
  Tailwind's Vite plugin and UnoCSS, whose CSS is generated after the HTML, through adapters that
  ask the project's own engine for the CSS of the page's classes (`size-12` is a 48 px box).
- Images from the API: with `sinter({ images: { remote: { url, cover, origins } } })`, an `<img>`
  whose `src` is bound to data (`data-sn-attr="{src: c.avatar}"`, rows included) gets a `srcset`
  of a resizing service's URLs, with widths from the box the stylesheets give it (a 40 px avatar:
  40, 80, 120, cropped with `cover`), and `sizes`, dimensions and loading attributes. `url` is a
  template (`{url}`, `{url:raw}`, `{w}`, `{h}`, `{q}`) or a preset: `cloudflare`, `vercel`,
  `netlify`, `imgproxy:<base URL>`. Only images from `origins` (`'self'` and listed origins) go
  through it; any other URL is written as it is. The service picks the format from `Accept`. In
  dev the dev server resizes (`/@sinter/remote`, sharp, the same origin rules). New module
  `@tiaforge-ui/sinter/remote` (0.5 KB gzip, only in pages that use it); testing:
  `render(html, { remoteImages, css })`. A build with the `vercel` preset prints the widths for
  `vercel.json`.
- Fluid images in a column: `sizes` from the narrowest container with a fixed width or an absolute
  `max-width` the image cannot overflow (`main { max-width: 800px }`, Tailwind's `max-w-3xl`,
  temper's `data-layout="center"`): `(max-width: 800px) 100vw, 800px`, files up to 3x of it.
  Static and API images. Only the attributes a binding writes are uncertain in the cascade now
  (`data-sn-attr`'s keys), not every attribute of the element.
- CSS backgrounds: `background` and `background-image` with `url()` of a local image get
  `image-set()` with AVIF (photos) or lossless WebP (graphics) and a JPEG/PNG fallback, after the
  original declaration. A rule that sizes the background (`cover`, `contain`, lengths) gets 1x and
  2x files, the source counting as 2x; one that does not keeps its intrinsic size (1x only). Dev
  rewrites the compiled CSS, builds the finished stylesheets, so Sass partials work.
- Warning `SN513 bound-local-image`: an `<img>` whose `src` is bound to local image paths (a literal,
  or a choice between literals) is not optimized; write each as a static `<img>` under
  `data-sn-if`/`data-sn-show`.
- Dev: a console warning for every image shown with fewer pixels than the screen has, naming the
  cause (a small source, or a `sizes` smaller than the image is shown).
- Next-page data: when a link to another page of the app is about to be followed (the pointer rests
  on it for 65 ms, it has focus, a mouse press starts on it, or a touch stays on it for 65 ms without
  becoming a scroll), the resources of that page whose
  request only the URL decides are requested, and the next page shows them at once, then
  revalidates (`$meta.loadedAt` stays null until the server answers, as with `cache`). Data the
  current page already loaded from the same request is handed over without one. Requests go
  through the middleware chain with low priority; a failed one never starts a login redirect; a
  mutation drops what was prefetched. Nothing to declare: the compiler describes each page, the Vite
  plugin shares one module of every page's description, `sinter({ prefetch: false })` turns it off.
  New module `@tiaforge-ui/sinter/prefetch`. Testing: `render(html, { pages: { 'article.html': … } })`.
  RealWorld in Chromium with a 1.5 s API: the article shows 215 ms after the click instead of after
  the API answers.

- Speculation Rules for links to the app's pages (their `data-sn-path` patterns or file paths,
  eagerness `moderate`). `sinter({ speculation })`: `'prefetch'` (default, the next page's HTML),
  `'prerender'`, or `false`. They are an inline `<script type="speculationrules">` in every page (no
  server setup). A CSP declared in the page (`<meta http-equiv="Content-Security-Policy">`) gets their
  hash from the build; a CSP sent as a response header needs `'inline-speculation-rules'` in
  `script-src`, and dev builds warn when it blocks them. `{ mode, delivery: 'header' }` writes
  `speculation-rules.json` at the site root for a `Speculation-Rules: "/speculation-rules.json"`
  response header instead, which no CSP blocks (the server sends the header and serves the file as
  `application/speculationrules+json`; `vite dev` and `vite preview` do both). Guide: `docs/navigation.md`. A prerendered page
  connects its streams once it is shown and refetches its resources then (`app.shown()` for features).

  `e2e/navigation` runs the default under `script-src 'self'`.
- `<html data-sn-prefetch="off">`: no other page prefetches this page's data or HTML, or prerenders it
  (for pages that do something when they load). Build time only: the attribute is stripped; anywhere but
  `<html>` it is `SN102`.
- `data-sn-transition` (value expression, a name): the same thing on two pages. Following a link from a
  list row to a page with an element of the same name morphs one into the other (cross-document view
  transitions; back from a page with one named element too). Only that pair gets a
  `view-transition-name`, during the transition. New module `@tiaforge-ui/sinter/transition`, added to
  pages that use the attribute. Testing: `r.window('pageswap' | 'pagereveal', { viewTransition, activation })`.
  Morphing elements also get `view-transition-class: sn-transition`, so
  `::view-transition-group(.sn-transition)` styles them all. When a morph is pending, the first paint of
  the next page waits for its page module (a small classic script in the head of pages that use the
  attribute), so data-rendered elements exist when the browser captures the page.
  RealWorld: an article's title morphs from the list, and back. For the morph back to a list, its rows
  must render from what the page has at mount: give the list `cache`.
- `e2e/navigation`: next-page data, Speculation Rules and morphs in headless Chrome.

### Changed

- The RealWorld article page's size budget is 22 KB (was 20 KB): next-page data adds 1.3 KB gzip to
  every page.

### Fixed

- A relative Vite `base` (`./`): the early file, the render-blocking paint script, the language
  picker and its files, and the page bundle's `async` were written as `./assets/…` on every page,
  so a page in a subfolder (`blog/post.html`) could not load them; they are relative to the page
  now, as Vite writes its own URLs.

## 0.9.0 (2026-11-08)

### Added

- Write-through: a mutation's 2xx response is applied to the resources it is about, after the
  optimistic commit and before `then`. Four rules, nothing declared: (1) an object of a named
  OpenAPI schema in the response patches the same-key item in every list of that schema, and the
  row, single resource or nested entity the action's URL or body read (`{article.author.username}`
  names `article.author`); (2) a POST to exactly a keyed list's current URL inserts the created
  item: the response's, else the body merged with the response's key (`{id: 42}`), else the list is
  refetched; (3) a PUT/PATCH body patches the entity the URL named; (4) a DELETE of a row's URL
  removes the row. Rules 1 to 3 need `sinter({ openapi })`; untyped pages get rule 4 and the
  body-only update. Patches merge and skip unchanged fields. New feature module
  `@tiaforge-ui/sinter/apply` (loaded by pages with something to apply), `data-sn-apply="off"` per
  element, warning `SN510 redundant-write` for a `then` that writes what a rule writes, dev log per
  application. Resources are matched to schemas by `$ref`, by an identical inline copy, or by an
  inline projection with fewer fields (RealWorld's list response). RealWorld: 12 of 19 `then`
  handlers removed. Testing: `render(html, { openapi })`.
- Loading optimizations that need no attributes:
  - Preconnect: every origin a literal resource or stream `src` names (`https://api.example.com/…`)
    gets `<link rel="preconnect" crossorigin>` in the head, so the connection is made while the page
    bundle downloads (with first paint on). RealWorld's pages name their API origin on every resource
    and had neither a preload nor an early request for it.
  - Request priority: a resource that only elements inside `<dialog>`s read (bindings, state,
    actions and handlers there, templates of the dialog included) is requested with
    `priority: 'low'`, and its preload link with `fetchpriority="low"`: the visible content's
    requests get the bandwidth first. Any read outside, by another resource or by a stream keeps
    the default.
  - Typing: a resource whose `src` or `when` changes only through keystrokes in a text field
    (`data-sn-model` on an `<input>` or `<textarea>`, `input` events) waits 250 ms for the next
    keystroke before it requests, instead of one aborted request per keystroke. Any other change
    (a select, a handler, `$url`) is requested at once. `settle()` in tests runs the pause.
  - Coming back: a `pageshow` after a back/forward-cache restore and `online` refetch every
    resource. Resources a stream feeds are left to the stream's reconnect, which already refetches
    them. Testing: `window('online')`.
  - Core +230 B gzip (RealWorld article 18.0 → 18.2 kB).

### Changed

- Compiled row creation. For a simple row template whose bindings do not read `$el`, the compiler
  emits a creation function (`make` on the template in the IR) that walks to the bound elements,
  evaluates the value expressions inline and writes them through the runtime's per-kind writers,
  which are the same code the generic path uses (URL and style checks included). Creating 1,000 rows
  in Chrome: sinter's click-to-flush time 2.07 → 1.9 ms against vanillajs's 1.6 (10,000 rows: 20.5 →
  18 ms against 15.5). A class binding's first write on a clone knows whether the source element has a
  `class` attribute (`cl` on the node). Core +0.1 KB gzip; a page module grows by one function per
  simple row template.
- The creation function walks only to elements with value bindings: an element with only handlers
  (a row's remove link) is not visited, as its handlers bind on its first event. Creating 1,000 rows
  in Chrome, sinter's click-to-flush time: 2.41 → 2.21 ms (10,000 rows: 24.0 → 20.5 ms), median of
  three interleaved page loads each, with vanillajs at 2.21 and 19.6 in the same session (see
  `docs/benchmark.md`). The core is unchanged.
- Simple rows keep no binding objects. A row template whose elements carry only value bindings and
  handlers (no state, model, nested template or dialog) now stores its last values in one array per
  row and finds its elements again from the row's first node when it renders; handlers in such rows
  bind to their element on its first event. One-element rows keep no node list. Behaviour is
  unchanged (a debounced handler keeps its timer across events, `run('id')` finds a row's action);
  memory per row drops: 1,000 rows take 2.19 MB instead of 2.51 (vanillajs 1.87; see `docs/benchmark.md`). Core +0.45 KB gzip.
- Selection bindings: a value binding in a row whose value is `row side === outer side` (or `!==`),
  such as `data-sn-class="{active: row.id === selectedId}"`, is re-evaluated only on the rows the
  comparison held for and on those matching the new value when the outer side changes, through an
  index of the rows the runtime builds on first use and drops whenever the rows render for another
  reason. Selecting a row in a 1,000-row table evaluates two bindings instead of 1,000
  (js-framework-benchmark select row, script time 5.2 → 2.2 ms; sinter's own flush takes 0.7 ms for
  the first selection, when the index is built, and 0.2 ms after); the result is the same. The compiler marks the pattern in the IR (`s` on the binding: both sides as functions and
  the outer side's dependencies); loose equality and comparisons inside larger expressions are
  rendered as before. Core +0.26 KB gzip.

### Fixed

- Firefox (no `blocking` attribute) no longer paints a page before its early file has rendered:
  the page's first classic script (the language picker, or `sinter-paint-<hash>.js` on pages with
  an early file and no messages) hides `<html>` and turns CSS transitions off until the early file
  has rendered and the stylesheets have applied (2 s at most for the hiding). A persisted
  collapsed rail no longer shows open for a frame, and nothing transitions from the unrendered
  state. Chromium is unchanged.
- `vite build` with Vite 8 no longer warns "`inlineDynamicImports` option is deprecated" once per
  page: the early file's build passes Rolldown's `codeSplitting: false` (Vite 6 and 7, on Rollup,
  keep `inlineDynamicImports: true`). Both put an early module's dynamic imports into the early
  file itself; the output is the same. An early build that still comes out as several chunks now
  fails the build instead of emitting an early file whose imports cannot load.

## 0.8.0 (2026-11-08)

### Added

- Resource names chosen by an expression: `refresh()`, `upsert()`, `patch()`, `remove()` and
  `page()` take a name the compiler can list from the source: a string literal, `?:`, `||` or `??`
  between such expressions, or a `data-sn-let` name whose value is one
  (`data-sn-let="{ shown: searching ? 'results' : 'messages' }"`, then `page(shown, 'next')`). Every
  name it can take gets the checks a literal gets (`SN301`, `SN303`, `SN304`, `SN501`, `SN509`).
  A computed `$meta[…]` key whose names can be listed is checked the same way and depends only on
  those resources' status; other computed keys stay unchecked. `sinter check`: a page number in
  `page()` needs every name to accept one; `upsert`/`patch`/`remove` take an item of any of the
  names' types.

### Changed

- Breaking (behaviour): `page()` with `prev` does nothing while `$meta.<name>.hasPrev` is false,
  and with `next` while `hasNext` is false, in every mode. Before, keyset and append sent the
  request anyway (`next` after a short page loaded an empty page), and offset `next` without a
  known total went on. `first` and `last` always load. Before the first load has come back, `prev`
  and `next` do nothing. Migration: a handler no longer needs `$meta.x.hasNext && page('x', 'next')`
  (the guard still works); a live keyset list that relied on `next` past a short page to find new
  items uses `refresh('x')` or a server event's `refetch` instead.
- Breaking (behaviour): bubbling custom events are notifications. `emit()`, islands'
  `CustomEvent`s, `sn-error` and the `listbox` module's `dismiss` no longer stop at the nearest
  element with a handler: every element from the target up with a `data-sn-on-<name>` for the
  event runs, inner first, until a handler calls `$event.preventDefault()` (the other handlers on
  that element and its action still run). `emit()` and `dismiss` are cancelable. Debounced
  handlers and actions triggered by a custom event pass it on (an `<a>` action no longer prevents
  a custom event). `sn-error`: an inner handler that does not prevent it lets outer handlers and
  then `onError` see the error. Native events, plain `Event`s and custom events with
  `bubbles: false` keep nearest-wins. There is no `stop()`, and `stopPropagation()` does not end
  the walk. Migration: where an element and one of its ancestors both handle the same custom
  event and only the inner one should run, add `$event.preventDefault()` to the inner handler
  (`data-sn-on-saved="saving = false; $event.preventDefault()"`); an island whose events must be
  stoppable dispatches them with `cancelable: true`.
- `SN301` for a name argument that cannot be listed (a state variable, a helper's result) now
  says which forms are allowed: "takes a resource name: a string literal, `?:`, `||` or `??`
  between them, or a `data-sn-let` name that is one".
- A resource named only in a store call (`refresh('x')`, `page('x', 'next')`) counts as used: no
  `SN501`.

### Fixed

- `SN301` for an unknown resource in `$meta.<name>.<field>` was reported twice.
- The early file no longer repeats work: a binding the build wrote into the HTML as a constant is
  left out of the early chunk (a persisted model stays in, its stored value is read early), and a
  resource whose literal `src` names an origin (`https://…`, `//…`) is no early request, as it is
  no preload: the early file sends same-origin requests only. A page with nothing else to run
  early has no early file. RealWorld: article 21.1 → 17.9 kB gzip, profile 21.1 → 17.9 kB, under the
  20 kB budget again.
- The early file carries the request machinery (URL templates, `$url`, `$now`, the handoff) only when
  the page has early requests, and no longer the runtime's default environment: about 1 kB gzip less
  per page with an early file (RealWorld index 20.9 → 20.0 kB, login 19.4 → 18.4 kB).
  `start(page, messages, requests?, doc?)` in `@tiaforge-ui/sinter/early`; `config.env` holds only
  what `configure({ env })` overrides (`envOf(config)` is the environment in use).
- The `listbox` module kept its document listeners after `destroy()`: in tests, each earlier
  `render()` with a `data-sn-listbox` fired `dismiss` (and handled arrows, Enter and Tab) once more.

## 0.7.0 (2026-11-08)

### Added

- First paint: pages render correctly before their module has run, and the page bundle is not
  render-blocking.
  - Build-time constants are written into the HTML: bindings outside templates that read only
    literal `data-sn-state` fields (each on its own) and constants, e.g. `aria-current` from
    `here === '/mail/'`.
  - The early chunk: per page, one file with nothing to import, loaded `type="module"
    blocking="render"` before the page module, so the first paint waits for one request. It runs the app's optional `src/sinter.early.ts` first (e.g. to pick the
    language), then, once, the bindings outside `data-sn-for` templates that need no data: state
    fields that need no data, persisted values read from storage, `$locale` and helpers, and the
    branch of a `data-sn-if` over them. It holds only the helpers those bindings call, and copies of
    modules it shares with the page bundle: state the early module sets (an i18n locale) is set
    again by the page bundle. Resources, `$url`, `$now`, `$meta`, `$el` and the
    built-in formatters wait for the page module.
  - The runtime takes the rendered DOM over: its first write changes nothing, and it adopts an
    early `data-sn-if` branch instead of rendering it again.
  - The build prints each page's early file and its size (gzip) and warns above `earlyBudget` (default
    10000 bytes), naming the largest modules.
- `sinter({ firstPaint: false })` turns it off; `sinter({ early: 'path' })` names another early
  module. Compiler options `prerender` and `early`; `CompileResult.early` is the page's early
  module. New entry `@tiaforge-ui/sinter/early`.
- Data requests before the page module (with first paint): a resource with a literal same-origin
  `src` and no `when` gets `<link rel="preload" as="fetch" crossorigin>` in the head; one whose URL
  reads only state that needs no data, persisted values, `$now`, `$url` and helpers is requested by
  the early file (not paginated, `each`, `call` or embedded ones). The request layer takes each
  early response once, at the end of the middleware chain, when the request is the one the early
  file sent (GET, same URL, same-origin credentials, only `Accept: application/json`): response
  middleware runs on it, a request middleware that changes the request gets a request of its own;
  what no resource took is aborted after mount. Size: the early file grows by about 1.1 kB gzip
  (URL templates, `$url`, the handoff).
- Testing: `firstPaint(html, { helpers, storage, early })` shows the page as it is before the
  page module runs; `render(html, { firstPaint: { early, afterEarly } })` mounts over it.
- Recipe "First paint: page chrome that renders before the script".
- Built-in messages, from an inlang project (`project.inlang/settings.json`, `messages/{locale}.json`
  of plain strings with `{param}`s; `sinter({ messages })` points elsewhere or turns it off):
  `m.key({ param })` in markup, `m` from the new `@tiaforge-ui/sinter/messages` in app code, typed
  by a generated `src/sinter.messages.d.ts`. Unknown keys are `SN206`, wrong parameters `SN208`;
  `m[key]` in a module fails the build. Per page and language the build emits a file with only
  the keys the page calls (markup and its modules), and every such page gets the picker and waits
  for the dictionary, also when only a helper, action or island it bundles calls `m`; missing translations fall back to the base
  language and are reported. A small classic picker script chooses the language before the first
  paint (stored choice, `navigator.languages`, base) and loads that file render-blocking; the early
  file and page module wait for it and hold no message text. `$locale = 'de'` stores the choice,
  loads that file and re-renders without a reload. No plurals or variants yet. Apps without an
  inlang project pay nothing (same build output byte for byte). Testing: `render(html, { messages })`.
  Recipe "Messages".

### Changed

- Breaking, for apps with an inlang project: `m` in markup is sinter's built-in messages. A helpers
  module that exports a namespace `m` (`export * as m from './paraglide/messages.js'`) is a build
  error then; remove it, drop the i18n library's Vite plugin and `configure({ locale })` (sinter is
  the locale source), and import `m` from `@tiaforge-ui/sinter/messages` in app code.
  `sinter({ messages: false })` keeps the old behaviour.
- `date`, `time`, `datetime`, `relative`, `number` and `bytes` reuse one `Intl` formatter per
  locale and options instead of building one per call (the largest script cost of a list of dates).
- The page bundle's script is `async` in builds (a deferred module waits for every pending
  stylesheet; on a warm load this starts the page's requests a round trip earlier). The page module
  waits before it mounts: `await parsed()`, or on a page with an early
  file `await rendered()`, both from the core (the parse, then the early file's render;
  an early file that failed to load does not hold it past DOMContentLoaded). Also for apps without
  first paint or messages: their page entry gets `async` and the page module awaits `parsed()`.
  App code in the page bundle may now run while the body is parsed: it must not read the body at
  module top level, and an island's `connectedCallback` may run before its children are parsed.
  The early module calls `start()` from `@tiaforge-ui/sinter/early` (was `early(document, …)`).
- `sinter()` from `@tiaforge-ui/sinter/vite` returns two plugins (`sinter` and `sinter:early`);
  `plugins: [sinter()]` works as before.

## 0.6.0 (2026-11-08)

### Added

- `refresh()` takes several names: `refresh('messages', 'results', 'unread')` refetches each
  named resource, instead of one `refresh()` statement per resource. Every name is a string
  literal naming a resource of the page (`SN301` otherwise, with a did-you-mean); the call is one
  statement for `SN507`, however many names it lists, and each name is an edge for `SN509`.
  `sinter check` types it as `refresh(...names)`. Core +8 B gzip.
- `page()` with a computed target on a keyset resource: `page('results', $event.shiftKey ? 'prev'
  : 'next')`, so one handler serves both directions (Caley needed `list-next` and `list-prev`).
  It was `SN304`, because the compiler cannot tell a computed direction from a page number.
  Now it compiles, and `sinter check` types it: on keyset without `offset-param` it must be a
  subset of `'first' | 'prev' | 'next' | 'last'`, else `SN208`, whose message says to add
  `offset-param` for page numbers. A literal page number stays `SN304`; `append` takes only the
  literal `'next'` (its `SN304` message now says so). At run time a target the resource cannot
  go to (a page number on keyset without `offset-param`, a string that is not a direction)
  sends no request: `$meta.<name>.error` with the reason, the unhandled-error path and a dev
  warning. It used to be a dev warning only, or, for an unknown string on keyset, a request.
  The paginate module grows by about 120 B gzip.

### Changed

- Event dispatch: the nearest element wins only if it handled the event. For keys, an element
  whose plain `data-sn-on-keydown`/`-keyup` ran without calling `$event.preventDefault()` now
  passes the key on to its ancestors. Caley's calendar binds N and P on `<body>`
  (`data-sn-on-keydown-shift-n`), and its week grid's plain arrow-key handler, which prevents
  only the arrows it uses, used to hide them for every key. A matching key filter, an action and
  a debounced handler still handle the key; clicks, other DOM events and custom events
  (`emit()`, islands, `sn-error`) are unchanged: any handler or action that ran handles them, so a
  button inside a clickable row still keeps the row's handler from running. Behaviour change:
  plain key handlers at two levels now both see the keys the inner one does not prevent; a plain
  handler that should keep keys from its ancestors prevents them. No sinter-level stop; non-bubbling
  events keep their nearest-ancestor reach, now written down. Core +22 B gzip.

### Fixed

- Spec, Pagination: `cursor` is evaluated on the boundary item *of the current page* (its last
  item for `next`, its first for `prev`; `first` and `last` send no cursor). "last item for
  `next`, first for `prev`" read as if the direction `first` mapped to `prev`. The modes table,
  the offset-param jump and the `direction-values` row say the same.

- `<sn-event>` `when`, `then`, `item` and `set` see the `data-sn-let` names declared around the
  `<sn-sync>`, resolved like state there: before payload fields of the same name. They were taken
  for payload fields, so a typed payload reported them as missing (`not on type EmailUpdatedEvent`),
  and `sinter check` declared a let and a payload field of one name in the same block (TS2451
  redeclare errors). The shadow now declares the payload outside the state and let blocks. With
  a typed payload, a let named like a payload field is a check error, as for state; a let that
  reads `$el` is `SN201` there.

## 0.5.0 (2026-11-08)

### Added

- `run('id')`, a store function that starts the action of the element with that literal id
  from any handler: `data-sn-on-*` (key filters included), `data-sn-then`/`data-sn-catch`,
  `<sn-event then>` and `<sn-resource then>`. The element's whole lifecycle applies, as if its
  trigger fired: debounce, confirm, its concurrency policy, the optimistic layer, `aria-busy`,
  `then`/`catch` and the unhandled-error path. A form is submitted with `requestSubmit()`
  (validation runs, `data-sn-on-submit` too); for any other element no DOM event is dispatched
  and `$event` is `null`. The target's own scope applies, `run()` takes no arguments and returns
  nothing. A disabled or inert target does nothing; a hidden one, or one in a closed dialog,
  runs; one that is not on the page (an `if` branch not rendered) does nothing, with a dev
  warning. Caley's case, marking a mail read once its body has loaded:
  `then="$result && !open.is_read && run('mark-read')"` with the action on a hidden
  `<span id="mark-read" data-sn-call="…" data-sn-optimistic="…">`. Islands still have no
  `app.run()`: they emit an event and the page runs the action. Core +86 B gzip.
- `SN311 unknown-run-target`: `run()` takes a string literal naming one element on the page that
  carries an action, outside `data-sn-for` rows, with a did-you-mean suggestion (and the LSP
  quick fix, which now also fixes `SN309` dialog ids).
- `sinter check` types `$event` in the URL, body, call arguments and confirm of a non-form
  `run()` target as `RunEvent<…>` (the event or `void`), so `$event.shiftKey` there is `SN208`
  and `$event && $event.shiftKey` is not.
- `SN509 run-cycle`, an opt-in warning for `then`/`catch` handlers that start each other again
  through `run()` (and `refresh()`), listing each step's element, handler and line. Off by
  default; `sinter check --check-cycles` for one run, `sinter({ checkCycles: true })` for the
  build, `sinter check` and `sinter lsp`.
- New recipe: run an action from a handler (mark a mail read after its body loaded; a shortcut
  on a button that is disabled when nothing is open).

- Key filters on keyboard handlers: `data-sn-on-keydown-<modifiers->key` and
  `data-sn-on-keyup-…` run only for that key, so each shortcut is its own attribute
  (`data-sn-on-keydown-j`, `-shift-n`, `-ctrl-space`, `-mod-enter`, `-escape`, `-question`).
  Modifiers are `ctrl`, `alt`, `shift`, `meta` and `mod` (Cmd on Apple platforms, Ctrl
  elsewhere), the key comes last: `a`–`z`, `0`–`9`, named keys (`enter`, `space`, `arrowdown`,
  `home`, `f1`…) and characters by name (`slash`, `question`, `minus`…). They match
  `KeyboardEvent.key`, so letters follow the layout; a letter filter falls back to the physical
  key when the layout gives no Latin letter. Modifiers are exact (`j` does not run for Ctrl+J);
  Shift is the filter's for letters and named keys (`n` vs `shift-n`) and not checked for
  characters that already say it (`question`, digits). Filters on an ancestor skip keys typed
  into fields and Enter/Space on buttons and links; a filter on the field itself runs. A match
  calls `preventDefault()`; repeats run; IME composition never matches. On one element, the
  matching filters and a plain `data-sn-on-keydown` run in attribute order, and an element
  whose filters do not match passes the key on to its ancestors. `data-sn-debounce-keydown-j`
  delays one filter. Unknown key or modifier names, uppercase (HTML would lowercase
  `-N` to `-n`) and malformed filters are `SN101` with a suggestion; `sinter check` types
  `$event` as `KeyboardEvent`. The matching is a feature module, `@tiaforge-ui/sinter/keys`
  (578 B gzip), loaded only by pages with a key filter; the core grows by about 17 B gzip.
  New recipe: keyboard shortcuts.

- `SN507 complex-expression`, a warning for expressions too complex for markup, naming the
  limit exceeded. It measures structure, not characters: statements in a handler
  (`statements`, 4), comma sequences (`sequences`, 0), steps one `&&`/`||`/`?:` used as a
  statement runs (`guarded`, 1: `a && close()` passes, `a && (b = null, close())` does not),
  `?:` nesting (`ternaries`, 2), operations in an arrow function (`arrow`, 8; block bodies
  always warn) and operations in one expression (`operations`, 15). Names, member paths,
  literals and object/array literal structure are free; object attributes are measured per
  property value. Configured with `sinter({ complexity: { …limits, level: 'warn' | 'error' |
  'off' } })`, which `sinter check`, `checkPage()` and `sinter lsp` read too; unknown limits or
  levels are refused. The recipes, RealWorld and the e2e pages pass: the SSE recipe's
  `<sn-event then>` closes the dialog and the dialog's `data-sn-on-close` clears the
  selection; RealWorld's tag input is `data-sn-on-keydown-enter="d.tagList = withTag(d.tagList, tag); tag = ''"`
  with a `withTag` helper (its editor page now loads the keys module, +550 B gzip). The docs' once-only `then` example is
  `draft = $result ?? draft; $result && showModal('compose')`.

- `sinter lsp`: an "Extract to helper" refactoring (`refactor.extract`). On an expression, or a
  selection inside one, it moves the expression into a new exported function of the helpers module
  (created when missing, `.ts` in a TypeScript project) and calls it in its place. Free names (loop
  variables, state, resources, `$event`, `$el`, `$result`, `$meta.<resource>`, …) become parameters,
  typed from TypeScript 7 when the project has it (`unknown` otherwise, JSDoc in a `.js` module);
  helpers, store functions and globals do not. In a handler the assignment stays and its value is
  extracted (`query = nextQuery(c)`); several assignments become one helper each, or one helper
  returning an object merged with `Object.assign` when they write properties of one state object. On
  `data-sn-call` and `<sn-resource call>`, "Extract to action" moves the call into a new action. Each
  extraction is compiled before it is offered. Code actions resolve their edit lazily when the
  client supports it. Runtime size is unchanged. `SN507` offers the same extraction as its quick fix.

### Docs

- The expression table no longer says handlers may call action functions: they call store
  functions, and start actions with `run('id')`. `SN203` for an action called in a handler now
  says so, with the hidden-element pattern as its hint.
- "What belongs in markup" in the spec and `llms.txt`: markup holds filters, conditions,
  single assignments and short calls; logic goes into helpers (pure) or actions (side
  effects), and handlers apply results as `state = fn(…)`, one step per condition. New recipe:
  row selection with Ctrl/Shift, `sel = rowClick($event, sel, f.id, ids)` with the helper and
  its unit tests.

### Changed

- `run` is a store function: a resource can no longer be named `run` (`SN209`), and a state or
  loop variable named `run` hides it in its scope. The internal `App.run()` (runs a handler
  expression) is now `App.exec()`.
- `data-sn-on-keydown-…` and `data-sn-on-keyup-…` are key filters now; a custom event whose
  name starts with `keydown-` or `keyup-` can no longer be handled with `data-sn-on-*`.

### Fixed

- `data-sn-prop` on a custom element that is already defined but not upgraded yet: a row of
  `data-sn-for` or a `data-sn-if` branch is cloned from the template and gets its props before
  it is connected, and only connecting upgrades it. The values were own properties that hid
  the class's setters (Caley's `<mail-frame>` in a list row showed an empty frame on a direct
  page load). The props of an element that is not an instance of its definition now go the
  same way as those of an element defined later: they are set again through the class when
  `customElements.whenDefined()` resolves, by which time the row is in the document. An upgraded element still pays one `customElements.get()` and an `instanceof`
  per write. 9 B gzip on the core.
- `render()` from `@tiaforge-ui/sinter/testing` took the `<html>` attributes from the first
  `<html` in the page's text, even inside a comment: Caley's calendar page explains its state
  in a comment that mentions `<html>` before the real tag, and the state was lost under jsdom
  (the comment's tail also became text in the body). `render()` now parses the page and takes
  the attributes and the content from its `<html>` element. The runtime is unchanged.
- `SN501` warned that a resource used only through its own `then` was never read, as in the
  spec's pattern `<sn-resource name="pending" call="mail.pendingCompose()" then="… $result && showModal('mail-compose')">`
  (Caley's share-to-mail). A resource with `then` now counts as used, whether or not the
  handler reads `$result`: a `then` that only notes the arrival (`then="loaded = true"`) is a
  reason to load it too.
- `data-sn-model` on a `<select>` inside a closed `<dialog>` was evaluated on every flush:
  bindings there wait for the dialog to open, but the pass that sets each select's value again
  after its options render did not. Caley's import dialog, `data-sn-model="imp.target"` while
  `imp` is null, warned "binding `model` on <select> threw" on each page load. That pass now
  defers selects in a closed dialog too, and runs once more when a dialog opens, so a select
  whose options render in the dialog gets its value. 13 B gzip on the core.

## 0.4.0 (2026-11-08)

### Added

- `then` on `<sn-resource>`: a handler expression run after each successful load, with `$result`
  being what the load stored (what `items` selects, the page just loaded, or one `each`
  source's items). It runs for the first load, `refresh()`, refetch events, `src`/`call`
  changes, every `page()` and embedded data; not for data `cache` shows before the
  revalidation, failed or superseded loads, optimistic layers or `upsert`/`patch`/`remove`.
  It runs after the store and `$meta` have the response, in the scope around the resource
  (state assignable), with store functions; as in `<sn-event then>`, `close()` must name its
  dialog and `reset()`/`emit()` are `SN203`. `sinter check` gives `$result` the resource's type
  (`type`, OpenAPI or the action's result). Handlers that should run once guard themselves:
  `then="$result && (compose = $result, showModal('mail-compose'))"`. The core grows by
  45 B gzip, the each module by 9 B.

### Changed

- Optimistic changes stay when the request succeeds. A 2xx response (or a call that resolves,
  or `app.optimistic()`'s `run`) commits the layer into the base before `then` runs, so a
  `then` write, and any later server event or refetch, still wins. Before, success dropped the
  layer, and a change `then` did not write again flipped back until the next refetch. Commits
  keep the order of the changes: a layer that succeeds while an older one is pending waits on
  top of it and joins the base when every older layer has settled (it leaves
  `$meta.<name>.pending` at once; a server write to the same item wins over it). A load in
  flight replays a commit on its response; a committed `remove` keeps `total` down. A
  superseded `GET` action now rolls its layer back instead of leaving it. The core grows by
  146 B gzip.

- An array as the whole value of a query parameter in a URL template is a repeated key, each
  item URL-encoded: `/api/search?q={q}&cal={cals}` with `['a', 'b']` sends `cal=a&cal=b`, as
  `data-sn-encoding="form"` does for bodies; `null`/`undefined` items are left out and an empty
  array leaves the parameter out. Before, the array was comma-joined (`cal=a%2Cb`). An array
  in the path is now refused (the request is not made, like a `..` segment), and `sinter
  check` reports it (`PathValue`). An array that is only part of a query value is comma-joined
  as before. 77 B gzip on the core.

### Fixed

- `data-sn-prop` on a custom element that is defined after sinter has set its properties (an
  island loaded with `import()`): the values were own properties that hid the class's setters,
  so the island never received them (Caley worked around it with an `upgradeProps()` helper).
  sinter now keeps the latest value of each property set before the definition and, when
  `customElements.whenDefined()` resolves, deletes the own property and sets it again through
  the class. Defined elements pay one `customElements.get()` per write. 88 B gzip on the core.
- `data-sn-attr` sets the live property for form state: `checked`, `selected`,
  `indeterminate` and `value` are set as properties as well as attributes, so a re-render or
  an optimistic rollback moves a control the user already changed (a clicked checkbox whose
  change rolls back unchecks). `null`/`false` set the property to `false` (`value`: `''`).
  Binding the `checked` (checkbox, radio) or `value` (other controls) that a `data-sn-model` on
  the same element writes is now `SN102`. 50 B gzip on the core.
- `render()` from `@tiaforge-ui/sinter/testing` keeps the `<html>` element's attributes. It
  kept only what was inside `<html>`, so `data-sn-state`, `data-sn-persist` or bindings on
  `<html>` were lost in tests although they work in the browser. Each render also clears the
  previous page's `<html>` attributes.
- `sinter check` read the types module's exported names from comments and strings too: a
  comment such as `// export type { Draft } from './compose'` in `src/sinter.types.ts` made
  `Draft` an export that the generated check file then imported. The scanner now skips
  comments and string and template literals; `@typedef`s are still read from comments.

## 0.3.3 (2026-11-08)

### Added

- `then` on `<sn-event>`: a handler expression run after the event's change is applied to the
  store, in the event's scope (payload fields as bare names, the state around the `<sn-sync>`,
  assignable). Store functions work in it; with no element, `close()` must name its dialog and
  `reset()`/`emit()` are `SN203`. With `then`, `resource` and `op` may be left out, so an event
  can only run a handler. `sinter check` types it with the payload's `type`, and an untyped
  event with `then` is `SN506`. For pages that close a detail dialog when the item it shows is
  removed: `then="sel?.uid === uid && (sel = null, close('contact-detail'))"`. The sse module
  grows by 51 B gzip, the core by 8 B.

## 0.3.2 (2026-11-08)

### Fixed

- `<sn-sync>` elements whose `src` resolves to the same URL share one connection, as the spec
  says: one transport, one session probe and backoff per reconnect, and every element's
  `<sn-event>` mappings apply (each in its own `<sn-sync>`'s scope). Before, each element opened
  its own, so a `<sn-sync>` in an `<sn-include>`d partial and one in the page held two
  EventSources. The sse module grows by 35 B gzip.

## 0.3.1 (2026-11-08)

### Changed

- Size budgets: the minimal page may be 15 KB gzip (was 11.5 KB; 0.3.0 shipped at 12.1 KB) and the
  RealWorld article page 20 KB (was 16.5 KB, with 24 B to spare). CI now runs `npm run size -- --check`,
  so an overrun fails the build.

### Fixed

- `app.state(el).update()` now reaches bindings inside `data-sn-for` rows: an island that changes a
  row's field or a nested list in place re-renders those rows. Before, only bindings outside the
  rows updated.
- Assigning `$locale` re-sorts resources with `order` by the new locale's collation. The store's
  cached view was never dropped for a locale change.
- A resource whose `when` turned false no longer overwrites its page-load cache entry with an
  empty list on pagehide.
- The 64 KiB `keepalive` limit is measured in UTF-8 bytes. A mutation body of 22,000 to 60,000
  non-ASCII characters was sent with `keepalive` and refused by the browser.
- A resource cannot take a store function's name (`remove`, `patch`, …): new `SN209` case. Such a
  page compiled, but `sinter check` failed with an internal error on it.
- `validateIR` accepts pages with `data-sn-call` and `<sn-resource call>`.
- A URL with a second `?` in its query keeps it when pagination parameters are added.
- A form with a scalar control and a nested one under the same name (`a`, `a.b`) serializes
  (the later control wins) instead of throwing.
- An app destroyed before its `<sn-sync>` streams connected opens none; a cleanup added after
  `destroy()` runs at once.
- A debounced `data-sn-on-*` handler does not run when its element left the page meanwhile.
- Keyset pagination: an empty `next` page reports `from` and `to` as 0 instead of 1 and 0. Offset
  pagination: `page(name, 'prev')` on page 1 and `page(name, 'next')` on the last known page send
  no request.
- `bytes('')` returns an empty string, like `number('')`.
- `data-sn-encoding="form"` serializes a form through `FormData`, as the browser would, instead of
  its own control walk (same fields, about 100 B less core).
- The compiler closes three lint gaps: a literal origin followed by a value needs its `/`
  (`https://api.example.com{x}` let the value extend the host; the runtime's origin check still
  refused the request), `Object.assign()` and `Object.defineProperty()` on a resource item are
  `SN205` (on state, a write, or `SN203` in a value expression), and `constructor`, `__proto__`
  and `prototype` named literally as `Object.*` arguments are `SN207`.

## 0.3.0 (2026-11-07)

### New

- `sinter check` types `data-sn-attr` values: a global `SinterAttributes` interface (empty by
  default) lists attribute value types, and a library extends it. With tinystyle,
  `import type {} from '@tiaforge-ui/tinystyle/sinter'` in the types module makes
  `{'data-tone': bad ? 'danger' : 'sucess'}` a type error. Keys it does not list are unchecked,
  as before. The types module is now always part of the check, so its `declare global`
  augmentations apply.
- `showModal('id')` opens `<dialog id="id">` as a modal from a handler, for
  example after a request (`data-sn-then="…; showModal('detail')"`) or from a
  custom event. `close('id')` closes a dialog by id; `close()` still closes
  the nearest one. The id must be a string literal naming a `<dialog>` on the
  page or its partials: new diagnostic `SN309 unknown-dialog`.
- `data-sn-let="{ hits: suggestions(q), n: hits.length }"`: derived names for an element
  and its subtree, compiled into the expressions that read them (no runtime cost). Read-only;
  new diagnostic `SN209 name-conflict` when one shares a name with state or a loop variable.
- `data-sn-confirm="question"` asks before an action runs (nothing when the value is falsy);
  `configure({ confirm })` replaces `window.confirm`.
- `data-sn-encoding="form"` sends a form or `data-sn-body` as
  `application/x-www-form-urlencoded` (arrays as repeated keys); `ctx.request` accepts a
  `URLSearchParams` body.
- `data-sn-listbox="list-id"` on a text input: the combobox keys for a suggestion list (arrows
  mark an option, Enter/Tab pick it, Escape fires `dismiss`), in the new `listbox` module.
- `$error.detail`: the server's message or a thrown error's, `null` when there is none.
- `data-sn-debounce-<event>="ms"` delays only that event's handler, e.g. a debounced
  `data-sn-on-input` next to an immediate `data-sn-on-blur`; it overrides `data-sn-debounce`
  for that handler, `0` makes it immediate.

## 0.2.0 (2026-11-06)

### Faster

Compared with 0.1.0 in Chrome 156, production builds:

- Writes to an ordered resource patch its sorted list instead of re-sorting
  it. Into 5,000 items, one upsert, patch or remove takes 0.005 ms instead of
  10 ms, a burst of 50 upserts 0.19 ms instead of 7.2 ms. A server event
  landing in a rendered sorted list flushes in 0.14 ms instead of 1.35 ms at
  1,000 rows, 0.7 ms instead of 11.2 ms at 5,000. Ties in `order` keep arrival
  order, as before; `replace` costs the same.
- A flush is about 2.5× cheaper per root binding: only bindings inside a
  `<dialog>` check for a closed one, and each binding keeps its parsed
  dependencies. One state change on a page with 4,000 root bindings: 0.18 ms
  instead of 0.44 ms.
- Identical expressions share one function in the compiled page module (the
  RealWorld article page has 60 instead of 112).

Row rendering (js-framework-benchmark) and mount time are unchanged. Pages are
0.6–0.8 KB gzip larger than with 0.1, mostly for the features below.

### New

- Local actions: `data-sn-call="ns.fn(args)"` calls a function from the actions
  module (`src/sinter.actions.js` or `.ts`) with the lifecycle of an action
  (busy, concurrency, optimistic layers, `then`/`catch`), and
  `<sn-resource call="…">` loads a resource from one, latest wins. Functions get
  a trailing context `{signal, request, el}`. New code `SN310 unknown-action`.
- `each="a in accounts"` on `<sn-resource>`: one request per list item, merged
  into one collection. A changed list loads only new sources and drops removed
  ones; a `refetch` event reloads only the source its payload names.
- `offset-param` on a keyset `<sn-resource>`: when the server also accepts an
  offset, `page(name, n)` jumps with it and `prev`/`next` continue by cursor;
  `$meta.<name>.page` is available. Without it, `SN304` now suggests it.
- `direction-values` on a keyset or append `<sn-resource>` maps sinter's
  directions to the values a server expects, e.g.
  `{first: 'forward', prev: 'backward', next: 'forward'}`. Directions not
  listed are sent by name, as before.
- `data-sn-debounce` on an element without a method delays its
  `data-sn-on-*` handlers: `<input data-sn-model="q" data-sn-on-input="query = q"
  data-sn-debounce="250">` updates `q` at once and `query` once typing pauses.
- `<sn-event>` expressions can read the state declared around their
  `<sn-sync>` (`when="mailbox === sel.mailbox"`), and `<sn-sync src>` is
  evaluated in that state's scope.
- A TypeScript helpers module (`src/sinter.helpers.ts`): export names are read
  with TypeScript syntax, type-only exports are not helpers, and
  `sinter check` accepts `.ts` import paths. Before, any type annotation in it
  failed every page's build with an acorn parse error.
- Helper and namespace modules may re-export with `export * from './x.js'`
  (relative paths only). Paraglide 2's message index is built this way, so
  `export * as m from './paraglide/messages.js'` used to find no messages
  (`SN206` on every `m.…()` call).

### Changed

- `<sn-event>`: a name declared by the surrounding state now shadows a payload
  field of the same name (before, it silently meant the payload field); a
  `sinter check` error when the payload is typed.
- `$error.status` (and `SinterError.status`) is `null` for a failed action
  call; its type is now `number | null`.
- Pagination cursor fields that are `null` or `undefined` are left out of the
  request instead of being sent empty, like URL template query parameters.
- `$meta.<name>.total` updates when the total or an optimistic removal changes
  it; before, it updated only when something on the page read the list.
- Resource lists are frozen in dev builds only, like their items (`SN205`
  refuses writes at build time). In production, code outside expressions that
  mutates `app.resource(name).all()` corrupts the store; copy it first.

## 0.1.0 (2026-11-05)

First implementation of the v0.1 spec: compiler, runtime, `sse`,
`optimistic`, `paginate`, `persist`, Vite plugin and testing module.

- `configure({ transport })` picks the `<sn-sync>` transport per stream URL;
  `@tiaforge-ui/sinter/ws` adds a WebSocket transport, and `llms.txt` has a
  SignalR recipe.
- `Transport.connect`'s `onEvent` now receives the parsed payload
  (`unknown`) instead of the raw string.
- `sinter check` type-checks expressions with the project's TypeScript:
  `type` on `<sn-resource>` and `<sn-event>`, OpenAPI specs
  (`sinter({ openapi })`), `sinter({ typecheck: true })` for `vite build`,
  `checkPage()` in `@tiaforge-ui/sinter/check`. New codes: `SN208`, `SN307`,
  `SN308`, `SN504`, `SN505`, `SN506`.
- `sinter lsp`: a language server with diagnostics as you type, type errors,
  hover, completion, go to definition and a did-you-mean quick fix; a VS Code
  extension in `editors/vscode`; setup for other editors in `docs/editors.md`.
- `Diagnostic` has an optional `span` (what an editor underlines).
- Diagnostics link to `docs/diagnostics.md`, generated from the compiler.
- The core's size budget is 11 KB min+gzip (was 5 KB, never met).
- `cache` on `<sn-resource>`: the page-load cache (sessionStorage, revalidated
  on every load, cleared on 401 and by `clearPersisted()`); the
  `@tiaforge-ui/sinter/cache` feature module.
- Dev builds warn when a stream is served over HTTP/1.1.
- Testing: `render({ session, storage })` and `memoryStorage()`.
