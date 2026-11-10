# Tasks: sinter + temper

A small task board: [sinter](https://github.com/tiaforge/sinter) binds the JSON API to plain HTML,
[temper](https://github.com/tiaforge/temper) styles the HTML. There are no components, no router
and no store, and the only CSS the app writes is for its one custom element.

```sh
npm install
npm run dev
```

## Try this

- **Open the page in two tabs.** Tick, add or delete a task in one; the other follows. The server
  sends events (`<sn-sync>` in `index.html`), and sinter applies them to the list.
- **Press "Fail next change", then tick a task.** The tick shows at once (`data-sn-optimistic`),
  the server refuses it, and the tick is taken back. The toast comes from `onError` in
  `src/sinter.config.ts`.
- **Press N.** A key filter on `<body>` opens the dialog. The dialog itself needs no JavaScript:
  `command="show-modal"` is the browser's.
- **Click the ring.** It is an island (`src/islands/task-chart.ts`): a custom element that draws
  on a canvas, gets the tasks through `data-sn-prop` and sends the filter back as an event.
- **Rest the pointer on a task, then click it.** Its data was requested while you pointed, so
  `task.html` shows it at once, and the title morphs into the page's heading.
- **Reload.** The list appears before the server answers (`cache`), and the filter is kept
  (`data-sn-persist`).
- **Change `--tm-hue` in `src/style.css`.** Every color follows, in light and dark mode.

## Break it on purpose

Both libraries check the markup at build time. Make these typos in `index.html` and run
`npm run build`:

| Change | Build error |
| --- | --- |
| `t.title` → `t.titel` | `SN208 Property 'titel' does not exist on type 'Task'. Did you mean 'title'?` |
| `visible(tasks, q, show)` → `visible(tasks, qq, show)` | ``SN201 `qq` is not defined here. Did you mean `q`?`` |
| `data-variant="ghost"` → `data-variant="danger"` on the delete button | `TM101 data-variant="danger" is not valid. Did you mean data-tone="danger"?` |

`npm run check` runs both checkers without building. Your editor can show the same errors as you
type: see sinter's `docs/editors.md`.

## Files

| File | What it is |
| --- | --- |
| `index.html`, `task.html` | The pages: `data-sn-*` for data, `data-*` from temper for looks. |
| `src/components/app-header.html` | A component: shared markup, expanded at build time where `<app-header>` is used. |
| `src/sinter.types.ts` | The API's types. `type="Task[]"` on a resource checks every expression that reads it. |
| `src/sinter.helpers.ts` | Functions expressions can call (`visible(…)`). |
| `src/sinter.config.ts` | Error handling, and the place to import islands. |
| `src/islands/` | Custom elements for browser work: canvas, editors, storage, timers. |
| `src/style.css` | temper's modules and the brand color. |
| `server/api.js` | The demo backend, running inside Vite. |

## Your own API

Remove `api()` from `vite.config.js`, delete `server/`, and proxy `/api` to your server in
development:

```js
server: { proxy: { '/api': 'http://localhost:3000' } },
```

In production, serve `dist/` and your API from the same origin. For an API on another origin, list
it in `sinter({ origins: ['https://api.example.com'] })`. With an OpenAPI spec,
`sinter({ openapi: 'openapi.yml' })` types resources without `type="…"`, checks request bodies, and
applies more responses to the lists by itself.

Serve the event stream over HTTP/2: over HTTP/1.1 each open tab holds one of the browser's six
connections per origin. The dev server is HTTP/1.1, so it warns in the console.

## Learn more

- sinter: `node_modules/@tiaforge-ui/sinter/llms.txt` (attributes, recipes and their tests)
- temper: `node_modules/@tiaforge-ui/temper/llms-full.txt` (attributes, tokens, recipes)
