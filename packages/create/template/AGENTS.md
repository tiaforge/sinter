# Notes for coding agents

- Data and behavior: sinter (`data-sn-*` attributes, `<sn-*>` elements). Read
  `node_modules/@tiaforge-ui/sinter/llms.txt` before editing pages.
- Styling: temper (`data-variant`, `data-tone`, `data-layout`, … with fixed values; no classes for
  looks, no margins). Read `node_modules/@tiaforge-ui/temper/llms.txt` before editing markup, and
  `llms-full.txt` before building whole pages.
- Browser APIs (storage, timers, canvas, `fetch`) are not allowed in expressions: put them in a
  component's script (`src/components/<name>.ts` beside `<name>.html`, extending the class imported
  from `./<name>.html`; it writes state, never nodes sinter renders).
- Types for `type="…"` go in `src/sinter.types.ts`.
- Run `npm run check` after editing; `npm run build` runs the same checks.
- `server/api.js` is a demo backend. Do not grow it into the real one.
