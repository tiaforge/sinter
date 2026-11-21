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
  of `() => m.key()` functions. The build writes the messages a page's modules call into the page, in its language
  (`<script type="application/json" data-sn-ns="m">`): nothing is loaded.
- Your helpers module must not also export a namespace `m`: one name calls one namespace.
- **Per tenant** ([docs/static-pages.md](static-pages.md#a-site-per-tenant-axes)):
  `inlang({ per: [tenants, locales], tenantFiles: (t) => './tenants/' + t.key + '/{locale}.json' })` reads a tenant's
  own files over the project's, so a tenant's file holds only the messages it changes.
- Not yet: markup in messages, which fails the build at its file and message.

A page has one language, chosen at build:

- A message over constants is written into the HTML, in text and attributes; one over data is compiled into the page
  with that message alone (a plain text needs nothing more; a plural or a formatted placeholder brings the formatter,
  `@tiaforge-ui/sinter/messages/format`). Nothing is hidden while it loads.
- With `sinter({ localePrefix: true })` each page is built once per language, under its prefix (`/de/about/`), and
  switching is a link (`localeUrl('de')`). See [docs/static-pages.md](static-pages.md#languages).
- Without `localePrefix`, the build is in the base language only, and the other languages' files are not used.
- `$locale` is the page's language and cannot be assigned (`SN203`).
- The messages are the locale source of `date()` and `number()`: do not also call `configure({ locale })`.

An app without `inlang()` in its content module ships none of this.

## Another library

`inlang()` is one content namespace; nothing else in sinter knows about it. Another library works the same way: register
your own namespace with `namespace()` and your own formatter ([docs/resources.md](resources.md#content-namespaces)), and
nothing of this module is in your build.

To switch the language in place without prefixed URLs, export the library's message functions as a namespace from the
helpers module (`export * as m from './paraglide/messages.js'`) and connect its locale with
`configure({ locale: { get, set } })`; `$locale = 'de'` then sets it.
