# Notes for coding agents

- Data and behavior: sinter (`data-sn-*` attributes, `<sn-*>` elements). Read
  `node_modules/@tiaforge-ui/sinter/llms.txt` once before editing pages. After that, look things up
  instead of reading it again: `npx sinter docs <topic>` prints one section (`layouts`, `static-pages`),
  an attribute or element (`data-sn-for`, `sn-event`) or a diagnostic (`SN318`); `npx sinter docs` lists
  the topics.
- Styling: temper (`data-variant`, `data-tone`, `data-layout`, … with fixed values; no classes for
  looks, no margins). Read `node_modules/@tiaforge-ui/temper/llms.txt` before editing markup, and
  `llms-full.txt` before building whole pages.
- Shared page markup (head, header, frame, toasts) is a layout: `src/layouts/app-layout.html`. Each page is only the
  layout's tag, `<app-layout data-sn-prop="{ title: '…' }">…</app-layout>`, and its children fill the layout's slots
  (`slot="head"` for head elements). Change the shared parts there, not in each page.
- Browser APIs (storage, timers, canvas, `fetch`) are not allowed in expressions: put them in a
  component's script (`src/components/<name>.ts` beside `<name>.html`, extending the class imported
  from `./<name>.html`; it writes state, never nodes sinter renders).
- Types for `type="…"` go in `src/sinter.types.ts`.
- Run `npm run check` after editing; `npm run build` runs the same checks. Strict mode is on: a warning
  fails like an error, and the dev server prints the browser's runtime warnings in the terminal. Fix
  what they report. Do not turn `strict` off, and add a code to `strict.allow` (with its reason) only
  when the user agrees that it should stay a warning.
- `server/api.js` is a demo backend. Do not grow it into the real one.
