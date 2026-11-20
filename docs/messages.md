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
<button data-sn-on-click="$locale = 'de'">Deutsch</button>
```

See [docs/recipes/messages.html](recipes/messages.html).

- The project is read from `project.inlang/settings.json` (`baseLocale`, `locales`, and the message-format `pathPattern`, default `./messages/{locale}.json`). Each file maps keys to plain strings with `{param}` placeholders. Plurals and variants are not supported, and a non-string message is a build error. Keys must be identifiers.
- An unknown key is `SN206` with a suggestion. Wrong or missing parameters are `SN208` in `sinter check`; a parameter is `string | number`.
- In app code, `import { m } from '@tiaforge-ui/sinter/messages'`, typed by the generated `src/sinter.messages.d.ts` (rewritten on every build and `sinter check`, so you can git-ignore it). Only `m.key` is allowed: `m[key]`, and passing or aliasing `m`, are build errors. For a dynamic choice use a map of `() => m.key()` functions.
- Your helpers module must not also export a namespace `m`.
- A missing translation falls back to the base language and is reported once per locale at build.
- Each page gets one small file per language holding only the keys it uses. Before the first paint the page picks the language: the stored choice (`localStorage` key `locale`), else the first match in `navigator.languages` (`de-AT` matches `de`), else the base. The base language's text is in the HTML, so visitors in that language see it in the first frame. For another language those elements stay hidden, keeping their space, until the page has rendered them.
- `$locale = 'de'` (or `setLocale('de')` from the messages module) stores the choice, loads the page's file for that language once, sets `<html lang>` and re-renders every message and every `date()` and `number()`. `onLocale(fn)` tells app code.
- With built-in messages sinter is the locale source: do not also call `configure({ locale })`.
- With `sinter({ localePrefix: true })` the language is in the URL instead (`/de/about/`): each page is built once per language with its text in the HTML, switching is a link (`localeUrl('de')`), and `$locale` cannot be assigned. See [docs/static-pages.md](static-pages.md#languages).

An app without an inlang project pays nothing for this: no picker, no language files.

To use another i18n library, export its message functions as a namespace from the helpers module (`export * as m from './paraglide/messages.js'`) and connect its locale with `configure({ locale: { get, set } })`.
