# Writing expressions: state, helpers and what belongs in markup

Every attribute value that is not a URL or a name is a JavaScript expression, checked at build time against a closed set of names: state, resources, magic names, store functions and your helpers.

## State

`data-sn-state` declares local variables for an element and what is inside it. The value is an object literal, so the compiler knows every name:

```html
<section data-sn-state="{ q: '', editing: null }">…</section>
```

`data-sn-let` names values computed from state, resources and loop variables, for use inside the element. Names are read-only and may not reuse a state or loop variable name (`SN209`):

```html
<div data-sn-let="{ hits: contacts.filter(c => c.name.includes(q)), n: hits.length }">
  <p data-sn-show="n" data-sn-text="n + ' found'"></p>
</div>
```

State lives with the page. `data-sn-persist="key"` on an element with a model or state stores it in `localStorage` under `sn:key`. See [docs/attributes.md](attributes.md).

## Helpers

`src/sinter.helpers.js` exports the functions your expressions call. Keep them pure: same arguments, same result, nothing read or changed elsewhere.

```js
// src/sinter.helpers.js
export const initials = (name) => name.split(' ').map((w) => w[0]).join('');
export * as fmt from './format.js';
```

```html
<span data-sn-text="initials(c.name)"></span>
<span data-sn-text="fmt.price(c.total)"></span>
```

- Exported names become functions. Type-only exports are skipped.
- `export * as ns from './module.js'` makes a namespace. The compiler reads its members, so `fmt.pirce(...)` is `SN206` with a suggestion. Members must be named literally: `fmt[key]` is refused. Only the members a page uses reach its bundle: the page module and the early file import each helper from the module that declares it, not through the helpers module.
- A `data-sn-let` (or a prop) is its expression, evaluated at every read, a helper call included ([spec.md](spec.md#derived-names)): a parse that three bindings read runs three times. Keep an expensive helper's results with `memo()` (below).
- A helper module that reaches a package of `lazy` loads only when a let first needs it ([lazy.md](lazy.md#helpers-that-wait)).
- The helpers module also runs in Node: the build, the dev server, `sinter check` and the language server
  load it before compiling, through Vite with your config (aliases and plugins apply), and a call over
  values known at build time runs there: its result is written into the page. Its top-level code runs in Node too: keep what needs the
  browser (`window`, `document`) inside the functions that use it. A module that cannot load in Node
  only warns (`SN533`, which strict mode does not fail on); the page works as before. Loading it takes
  one extra Vite server per build, a few hundred milliseconds.
- Whether a helper's calls can run at build time is decided from its code: it, and everything it calls
  and imports, may use only JavaScript's own deterministic globals (`Math`, `JSON`, `Array`, `Map`, …)
  and `TextEncoder`, `TextDecoder`, `URL`, `URLSearchParams` and `structuredClone`, not `Date`, `Intl`,
  `Math.random`, `toLocale…`, `fetch`, `window` or `process`. Each exported function
  counts on its own: one date formatter does not stop the others in its module. Its result must be plain
  data; a call that throws or returns anything else stays in the browser (`SN534` in dev builds, which
  also run each call twice: a helper that returns another result the second time is not pure).
- Re-exports follow relative paths only.

### Memoized helpers

A helper that does real work (a document parse, a search index, a layout) can keep its results with `memo()`:

```ts
// src/sinter.helpers.ts
import { memo } from '@tiaforge-ui/sinter/memo';
import { parseDocument } from './parser.ts';

export const parse = memo(parseDocument);
export const toc = memo((body: string, depth: number) => headings(parseDocument(body), depth), { maxSize: 2 * 1024 * 1024 });
```

- It keeps a result by its arguments when each is a primitive, or a plain object or array of primitives
  (`{ strict: true }`, `['a', 'b']`), compared by content: equal arguments return the same result. The
  order of an object's keys is part of the key (`{ a, b }` and `{ b, a }` are two calls), and so are an
  array's holes and an object's null prototype. Anything else calls through every time, uncached: a
  nested object, a `Map`, a class instance, a function, a symbol, an object with a symbol key, a getter
  or a non-enumerable property, an array with properties besides its elements. Such a call gets your
  arguments as they are, and its result is neither copied nor frozen. `this` is passed on and is not part
  of the key.
- **It takes everything it depends on as arguments.** A memoized function must not read anything that
  changes (the locale, the time, a global, another module's state): pass it in (`parse(body, $locale)`).
- A kept call's object arguments are copied before the call (each own key, `__proto__` included), so its
  result never holds your object (state you change later). Its result is then frozen in place, at every
  depth, in production too, and shared by every caller: change a copy (`structuredClone(doc)`). A result
  that holds anything but plain data (a `Map`, a `Set`, a `Date`, a typed array, a class instance, a
  function) is returned as it is: not frozen, not kept.
- The cache is bounded by an approximate size (`maxSize`, in bytes, 4 MiB by default: a string counts
  2 bytes a character, every value and entry a few more): the least recently used results go first. The
  most recent result is always kept, even one larger than `maxSize`, alone then, so a page that reads a
  huge parse at every node does not parse it again at every read; the next result takes its place.
  `parse.clear()` forgets them all. A call that throws keeps nothing.
- It works in the page module, the early file and in Node: a memoized helper's calls over build-time
  values run at build time as the function it calls would (its cache is the memo's own state, which the
  build's checks allow). Each bundle has its own cache: the early file and the page module each parse once.

### Built-in formatters

Always available, no import. They read the current locale, so a locale switch updates them. Each `Intl` formatter is built once per locale and options, then reused.

The locale, and `$locale`, is one of these, the first that applies:

1. The app's own source, `configure({ locale })` ([docs/configuration.md](configuration.md)): its locale, in the
   browser only. The build looks for it in the config and early modules (`src/sinter.config.*`, `src/sinter.early.*`)
   and the app modules they import: a `locale` key, an assignment to a `.locale`, or a `configure()` whose options it
   cannot read (a spread, a variable). With one, nothing is formatted at build time and `<html lang>` is not used. A
   source set elsewhere (a component's script) is out of its sight: dev builds then warn (35) on a page whose HTML
   has text formatted in `<html lang>`.
2. The page's language with [`languages()`](static-pages.md#languages).
3. The page's `<html lang>` (or its layout's) as written: at build time, in the first paint and in the browser alike
   (`<html lang="de">`: `number(1234.5)` is `1.234,5` for every visitor). A page sets it when it formats something
   (a built-in formatter, `$locale`, a component's script); an app helper, an action or a custom element that calls
   sinter's `date()` itself gets it on those pages only, or on a page a swap reached from one of them (within one
   language, the locale stays).
4. Otherwise the browser's default locale, and `$locale` is `undefined`: with no `lang`, one a binding sets
   (`data-sn-attr="{ lang: … }"` on `<html>` or a layout's tag), or one `Intl` does not take (`en_US`).

To format by the visitor's browser locale in an app with `<html lang>`, give it as the source:
`configure({ locale: { get: () => navigator.language, set() {} } })`. `$locale` is then the browser's language, not
`undefined`, and `$locale = 'x'` in a handler changes nothing.

| Helper | Example | Result in `en` |
| --- | --- | --- |
| `date(v, style, timeStyle)` | `date(c.born, 'long')` | `March 4, 1990` |
| | `date(c.at, 'medium', 'short')` | `Mar 4, 1990, 9:30 AM` |
| | `date(c.at, null, 'short')` | `9:30 AM` |
| `relative(v)` | `relative(c.at)` | `3 days ago` |
| `number(v, opts)` | `number(c.total, { style: 'currency', currency: 'EUR' })` | `€12.50` |
| `bytes(v)` | `bytes(f.size)` | `1.5 MB` |

`style` and `timeStyle` are `'full'`, `'long'`, `'medium'` or `'short'`; the date defaults to `'medium'` and the time to none, and `null` leaves the date out (`time()` and `datetime()` were these two until 2026-11-20). `opts` are `Intl.NumberFormat` options. Missing or invalid values give an empty string, not `Invalid Date`.

A calendar date, a string `YYYY-MM-DD` (`'2026-11-11'`), is the same day for every visitor: `date()` formats it in UTC,
where it was parsed, so it never shows the day before west of Greenwich. A moment (a timestamp, a `Date`,
`'2026-11-11T09:00:00Z'`) is shown in the visitor's time zone. In a page built in one language
([`localePrefix`](static-pages.md#languages), or a literal `<html lang>` in an app that sets no locale), `number()`, `bytes()`
and `date()` of a calendar date over constants are written into the HTML at build time; moments, times and
`relative()` are formatted in the browser.

## What belongs in markup

Every attribute value that is not a URL or a name is a JavaScript expression, parsed at build time and checked against a closed set of names.

| Kind | Used in | Allowed | Refused |
| --- | --- | --- | --- |
| Value | `text`, `attr`, `class`, `show`, `with`, `for` (after `in`), `if`, `key`, `body`, `state`, URL interpolations | any expression: template strings, `?.`, `??`, arrow functions as arguments, `new` on allowed globals | assignment, `++`/`--`, `delete`, `await`, `import()` |
| Handler | `on-*`, `then`, `catch`, `optimistic` | statements separated by `;`, assignment to state, calls to store functions | declarations, loops, `await` |

A name resolves to the first match, innermost first: loop variables, state, resources, magic names (`$event`, `$el`, `$url`, `$now`, `$locale`, `$result`, `$error`, `$meta`; and where they apply, `$item` in `paginate`'s cursor, `$slot` in a fill of a slot declared `Slot<T>`, `$site` and `$canonical` with `sinter({ site })`), then helpers, namespaces and store functions (`refresh`, `upsert`, `merge`, `remove`, `page`, `openDialog`, `closeDialog`, `closePopover`, `emit`, `run`, `navigate`), then allowed globals. Anything else is `SN201` with a suggestion.

Globals are JavaScript, not the browser. `Math`, `JSON`, `Object`, `Array`, `Set`, `Map`, `Date`, `Intl`, `RegExp`, `URL`, `URLSearchParams` and `structuredClone` work. `window`, `document`, `fetch`, `localStorage`, timers, `eval`, `Function`, `Proxy` and `Reflect` do not (`SN202`): browser work belongs in a [component's script](islands.md). In a binding, `Date.now()` and `Math.random()` never update, so use `$now` (`SN502`).

Markup holds filters, conditions, single assignments and short calls. Logic that computes a value goes into a helper; logic with side effects goes into an action ([docs/actions.md](actions.md)). The handler applies the result:

```html
<!-- not four lines of if/else on $event.shiftKey -->
<li data-sn-on-click="sel = rowClick($event, sel, f.id, ids)">

<!-- a guard over one step is fine -->
<button data-sn-on-click="open && closeDialog('detail')">
```

One condition per step. `a && (b = null, closeDialog())` is two steps behind one guard: write them as separate statements, or compute the new state in a helper.

### Complexity limits (`SN507`)

Expressions that outgrow markup get warning `SN507`, naming the limit they exceed. The measure is structure, not length.

| Limit | Default | Counts |
| --- | --- | --- |
| `statements` | 4 | `;`-separated statements in one handler |
| `sequences` | 0 | comma sequences `(a, b)` |
| `guarded` | 1 | steps one `&&`, `\|\|`, `??` or `?:` statement runs: `a && closeDialog()` is 1, `a && (b = 1, closeDialog())` is 2 |
| `ternaries` | 2 | nesting of `?:` |
| `arrow` | 8 | operations in one arrow function body; a block body is always too many |
| `operations` | 15 | operations in one expression, the backstop |

Operations are calls, `new`, operators, assignments, computed member access and functions. Names, member paths (`a.b.c`), literals and object and array structure are free, so a draft object of plain fields costs nothing. Filters like `people.filter(p => p.name.includes(q))` stay under the limits.

```js
sinter({ complexity: { level: 'error' } })   // SN507 fails the build
sinter({ complexity: false })                // no SN507
```

The limits are the same in every project, so markup reads alike wherever it is. The setting also applies to `sinter check` and the editor. In an editor, the quick fix for `SN507` extracts the expression into a helper ([docs/editors.md](editors.md)).
