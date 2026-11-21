# Messages

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
