# Messages

> The built-in messages (`sinter({ messages })`) are deprecated: read the same inlang files with
> [`inlang()`](#messages-as-a-content-namespace), which adds nested keys, plurals, formatted placeholders and fallback
> chains. A build with the built-in messages warns, naming the two lines to change.

Messages come from an inlang project, so the inlang tools (VS Code extension, Fink, machine translation) keep working on the same files.

```
project.inlang/settings.json
messages/en.json      { "inbox_title": "Inbox", "inbox_count": "{count} unread" }
messages/de.json      { "inbox_title": "Posteingang", "inbox_count": "{count} ungelesen" }
```

```html
<h1 data-sn-text="m.inbox_title()"></h1>
<p data-sn-text="m.inbox_count({ count: inbox.unread })"></p>
<a hreflang="de" data-sn-attr="{ href: localeUrl('de') }">Deutsch</a>
```

See [docs/recipes/messages.html](recipes/messages.html).

- The project is read from `project.inlang/settings.json` (`baseLocale`, `locales`, and the message-format `pathPattern`, default `./messages/{locale}.json`). Each file maps keys to plain strings with `{param}` placeholders. Plurals and variants are not supported, and a non-string message is a build error. Keys must be identifiers.
- An unknown key is `SN206` with a suggestion. Wrong or missing parameters are `SN208` in `sinter check`; a parameter is `string | number`.
- In app code, `import { m } from '@tiaforge-ui/sinter/messages'`, typed by the generated `src/sinter.messages.d.ts` (rewritten on every build and `sinter check`, so you can git-ignore it). Only `m.key` is allowed: `m[key]`, and passing or aliasing `m`, are build errors. For a dynamic choice use a map of `() => m.key()` functions.
- Your helpers module must not also export a namespace `m`.
- A missing translation falls back to the base language and is reported once per locale at build.
- A page has one language, chosen at build. Its text is in the HTML, in text and attributes, and a message its code still needs is compiled into its script in that language: nothing is loaded for it, nothing is hidden.
- With `sinter({ localePrefix: true })` each page is built once per language, under its prefix (`/de/about/`), and switching is a link (`localeUrl('de')`). See [docs/static-pages.md](static-pages.md#languages).
- Without `localePrefix`, the build is in the base language only, and the other languages' files are not used.
- `$locale` is the page's language and cannot be assigned (`SN203`).
- With built-in messages sinter is the locale source: do not also call `configure({ locale })`.

An app without an inlang project pays nothing for this.

To switch the language in place without prefixed URLs, use another i18n library: export its message functions as a namespace from the helpers module (`export * as m from './paraglide/messages.js'`) and connect its locale with `configure({ locale: { get, set } })`; `$locale = 'de'` then sets it.

## Messages as a content namespace

The same inlang files can be read by `inlang()`, a [content namespace](resources.md#content-namespaces) loader that
ships in this package, `@tiaforge-ui/sinter/messages/content`. It reads the inlang message format 4 with what the
built-in messages refuse:

```ts
// src/sinter.content.ts
import { languages } from '@tiaforge-ui/sinter/content';
import { inlang, inlangLocales } from '@tiaforge-ui/sinter/messages/content';
export const locales = languages(inlangLocales('project.inlang'));
export const messages = inlang();          // the namespace `m`
```

```js
// vite.config.js: one name calls one namespace, so the built-in messages are off
sinter({ localePrefix: true, messages: false })
```

```html
<h1 data-sn-text="m.inbox.title()"></h1>
<p data-sn-text="m.inbox.unread({ count: inbox.unread })"></p>
```

- **Nested keys** (`{ "inbox": { "title": "Inbox" } }`) are dotted ids, called as `m.inbox.title()`.
- **Complex messages**: `[{ declarations, selectors, match }]` with `input x`, `local n = x: plural` (with
  `type=ordinal`), `local y = x` for an exact value, selectors on inputs, `*` and several selectors. Plurals use the
  page's language's categories (`Intl.PluralRules`); an exact number wins over the category that also selects it.
- **Escapes**: `\{`, `\}`, `\\`. **Several files**: `pathPattern` may be a list, merged in order.
- **Fallback chains**: a message missing in `de-AT` is `de`'s, then the base language's.
- A message over constants is written into the HTML; one over data is compiled into the page with that message alone
  and the formatter (`@tiaforge-ui/sinter/messages/format`).
- **Per tenant** ([docs/static-pages.md](static-pages.md#a-site-per-tenant-axes)):
  `inlang({ per: [tenants, locales], tenantFiles: (t) => './tenants/' + t.key + '/{locale}.json' })` reads a tenant's
  own files over the project's, so a tenant's file holds only the messages it changes.
- **Types**: `sinter check` types each message from the base language: a plural's input a `number`, a placeholder `string | number`; a wrong parameter is `SN208`.
- **Formatted placeholders**: `{rate: number style=percent}`, `{at: datetime dateStyle=long}`, with `Intl` in the page's
  language and the options as written.
- **App code**: `import { m } from '@tiaforge-ui/sinter/messages'` and `m.inbox.title()`, as with the built-in messages: the
  build writes the messages a page's modules call into the page, in its language.
- Not yet: markup in messages, which fails the build at its file and message.

Another library works the same way: register your own namespace with your own formatter, and nothing of this module is
in your build.
