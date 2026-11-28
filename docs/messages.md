# Messages

Messages come from an inlang project, so the inlang tools (VS Code extension, Fink, machine translation) keep working on
the same files. The content module reads them with `inlang()`, a [content namespace](resources.md#content-namespaces)
that ships in this package (`@tiaforge-ui/sinter/messages/content`), and takes the site's languages from the same
project:

```
project.inlang/settings.json
messages/en.json      { "inbox": { "title": "Inbox", "unread": "{count} unread" } }
messages/de.json      { "inbox": { "title": "Posteingang", "unread": "{count} ungelesen" } }
```

```ts
// src/sinter.content.ts
import { languages } from '@tiaforge-ui/sinter/content';
import { inlang, inlangLocales } from '@tiaforge-ui/sinter/messages/content';
export const locales = languages(({ root }) => inlangLocales('project.inlang', root));
export const messages = inlang();          // the namespace `m`
```

```html
<h1 data-sn-text="m.inbox.title()"></h1>
<p data-sn-text="m.inbox.unread({ count: inbox.unread })"></p>
<a hreflang="de" data-sn-attr="{ href: localeUrl('de') }">Deutsch</a>
```

See [docs/recipes/messages.html](recipes/messages.html). `npx sinter migrate --write` writes the content module's
part for a project that had the built-in messages (`sinter({ messages })`, removed).

- The project is read from `project.inlang/settings.json` (`baseLocale`, `locales`, and the message-format
  `pathPattern`, default `./messages/{locale}.json`). It reads the inlang message format 4.
- **Nested keys** (`{ "inbox": { "title": "Inbox" } }`) are dotted ids, called as `m.inbox.title()`.
- **Complex messages**: `[{ declarations, selectors, match }]` with `input x`, `local n = x: plural` (with
  `type=ordinal`), `local y = x` for an exact value, selectors on inputs, `*` and several selectors. Plurals use the
  page's language's categories (`Intl.PluralRules`); an exact number wins over the category that also selects it.
- **Formatted placeholders**: `{rate: number style=percent}`, `{at: datetime dateStyle=long}`, with `Intl` in the page's
  language and the options as written.
- **Escapes**: `\{`, `\}`, `\\`. **Several files**: `pathPattern` may be a list, merged in order.
- **Fallback chains**: a message missing in `de-AT` is `de`'s, then the base language's. A message missing in the base
  language's whole chain is reported once per language at build.
- **Types**: an unknown key is `SN206` with a suggestion. `sinter check` types each message from the base language: a
  plural's input a `number`, a placeholder `string | number`; a wrong parameter is `SN208`.
- **App code**: `import { m } from '@tiaforge-ui/sinter/messages'` and `m.inbox.title()`, typed by the generated
  `sinter.namespaces.d.ts` next to the content module (rewritten on every build and dev load, so you can git-ignore
  it). Only `m.key` is allowed: `m[key]`, and passing or aliasing `m`, are build errors. For a dynamic choice use a map
  of `() => m.key()` functions. The build gives each page the messages its modules call, in its language, a plain
  message as its text ([the page's dictionary](#the-pages-dictionary)). A page whose modules call no message ships
  none of this module, and a module brings the formatter only when it calls a plural or a formatted placeholder.
- Your helpers module must not also export a namespace `m`: one name calls one namespace.
- **Per tenant** ([docs/static-pages.md](static-pages.md#a-site-per-tenant-axes)):
  `inlang({ per: [tenants, locales], tenantFiles: (t) => './tenants/' + t.key + '/{locale}.json' })` reads a tenant's
  own files over the project's, so a tenant's file holds only the messages it changes.
- Markup in a message is not supported: it fails the build at its file and message.

A page has one language, chosen at build:

- A message over constants is written into the HTML, in text and attributes; one over data is compiled into the page
  with that message alone (a plain text needs nothing more; a plural or a formatted placeholder brings the formatter,
  `@tiaforge-ui/sinter/messages/format`). Nothing is hidden while it loads.
- With `sinter({ localePrefix: true })` each page is built once per language, under its prefix (`/de/about/`), and
  switching is a link (`localeUrl('de')`). See [docs/static-pages.md](static-pages.md#languages).
- Without `localePrefix`, the build is in the base language only, and the other languages' files are not used.
- `$locale` is the page's language and cannot be assigned (`SN203`).
- The page's language is the locale of `date()` and `number()`, messages or not, unless the app's
  `configure({ locale })` sets one.

An app without `inlang()` in its content module ships none of this.

### The page's dictionary

The messages a page's modules call (`m.key()` in app code, not the ones in markup, which are compiled into the page)
are the page's dictionary: one entry per message, in the page's language. A build puts it in two places.

- **In a file of its own**, `assets/<language>-m-<hash>.js`, for each page and language; pages with the same
  entries share one. The page script imports it
  before anything else, so every module of the page, at its top level too, finds its messages there. The file's
  name has the hash of its text, like every file under `assets/`: serve it with the same long-lived cache headers
  (`Cache-Control: public, max-age=31536000, immutable`). The page asks for it with the page script
  (`<link rel="modulepreload">`, right after the script's own tag), and a later visit takes it from the cache.
  When a text changes, the file and the page script that imports it get new names, for that page and language only.
- **In the page**, before the head scripts
  (`<script type="application/json" data-sn-ns="m" lang="de">`): only the entries the
  [early script](first-paint.md#the-early-script) still reads, because it runs before the page script. Since the
  early script has its texts written in (below), most pages keep none, and have no such element.

A dictionary under 1,024 bytes of JSON (about 0.4 kB compressed) stays in the page whole, with no file: a request of
its own would cost more than it saves. The dev server and `sinter render` write the whole dictionary into the page.

#### Messages in the early script

The early script is built once per language, and a build writes each message its modules call as the text it has
in the page's language (its chain's, `de-AT` → `de` → the base language), so the early script needs neither the
entries nor the messages module. What is written is what the messages module would give at run time, to the
character: `m.nav_mail()` becomes `"Mail"`; `m.hello({ name: who })` becomes `"Hello "+String(who)+"!"`; a call whose
argument is not an object literal (`m.hello(params)`), and a message called through a variable
(`label: m.event_dayMo`, called later), become a small function that does what the module does (a placeholder the
argument lacks stays as written, `{name}`). A text may hold anything (quotes, a newline, `</script>`, `${`).

Left to the page's dictionary, which then keeps those entries in the page as before:

- a plural or a formatted placeholder (`{count: plural}`, `{rate: number}`): the call reads its entry, and the
  formatter is registered as the call is made;
- a message referenced in a way that stays in the early script as a value (`typeof m.key`, or a function the script
  keeps): the build tries the texts, sees the reference left, and builds that early script again with every reference
  as written;
- every use in a module that names `m` for something else too (a parameter, a local) or has a `String` of its own;
- the shared head script, which every page runs, when the pages are in more than one language (one language, or a
  single build without `localePrefix`: it has the texts too).

If a module in the early script reaches the messages another way than `m.key` (the module's `t(key)`, a re-export of
`m`, a package the build does not read), the build cannot tell, and the page keeps its whole dictionary in the page as
well. Nothing to configure.

## Another library

`inlang()` is one content namespace; nothing else in sinter knows about it. Another library works the same way: register
your own namespace with `namespace()` and your own formatter ([docs/resources.md](resources.md#content-namespaces)), and
nothing of this module is in your build.

To switch the language in place without prefixed URLs, export the library's message functions as a namespace from the
helpers module (`export * as m from './paraglide/messages.js'`) and connect its locale with
`configure({ locale: { get, set } })`; `$locale = 'de'` then sets it.
