<!-- sinter's agent notes from its starter template (packages/create/template/AGENTS.md), keeping the lines that apply to
any sinter project: the template's own files, its demo server and the temper styling lines are left out. -->

# Notes for coding agents

- Data and behavior: sinter (`data-sn-*` attributes, `<sn-*>` elements). Read
  `node_modules/@tiaforge-ui/sinter/llms.txt` before editing pages.
- Browser APIs (storage, timers, canvas, `fetch`) are not allowed in expressions: put them in a
  component's script (`src/components/<name>.ts` beside `<name>.html`, extending the class imported
  from `./<name>.html`; it writes state, never nodes sinter renders).
- Run `npx sinter check` after editing; `npm run build` runs the same checks. Fix what they report. Do not
  turn `strict` off.
