# Service dashboard

[![Open in StackBlitz](https://developer.stackblitz.com/img/open_in_stackblitz.svg)](https://stackblitz.com/github/tiaforge/sinter/tree/main/examples/dashboard)

Four services with made-up metrics, live. One HTML page, no framework, no store:

- **The backend describes itself.** `server/openapi.yml` is the API's OpenAPI file; `server/api.js`
  serves it at `/api/openapi.yml` and implements it. The frontend reads the same file at build
  time (`sinter({ apis: { dashboard: { openapi } } })`): pages write paths relative to its server,
  `/api`, so `<sn-resource src="/services">` needs no `type` (it is `listServices`), and a path or
  query parameter the spec does not have fails the build. The event stream is not in the spec, so
  the config declares it.
- **Samples are a resource, and each event is one new sample.** `samples` (`GET /api/samples`) is the last
  30 seconds, loaded once. Four times a second `server/api.js` makes up the next sample of each running
  service (a random step, now and then a slow, failing spell) and sends it as a `sample` event (about 150
  bytes); `<sn-sync>` in `index.html` upserts it into `samples`. `slot` is the resource's key
  (`gateway:17`): a new sample takes the slot of the oldest, so the resource stays the same size however
  long the page is open, with nothing to delete. `services` only holds `{ id, name, paused }`; a
  `service_updated` event is for a pause or resume.
- **The graphs are drawn from the store.** The helpers in `src/sinter.helpers.ts` turn the samples into
  what the page shows: `of()` picks a service's, `rates()` and `combined()` give the series, `totals()` the
  newest numbers, and `line()` and `area()` the SVG `points` of `<spark-line>`. The component's script
  (`src/components/spark-line.ts`) only slides the line one step left per sample, so it moves instead of
  jumping. No chart library.
- **Layout and components.** `index.html` is one `<app-layout>` tag (`src/layouts/app-layout.html`:
  the head and the header). `<stat-tile>`, `<spark-line>` and `<service-card>` are plain HTML files in
  `src/components/`, expanded at build time, so they are in the first frame and never hydrate (only
  `<spark-line>` has a script, for the sliding). The Pause
  button is slot content: the page's own markup, in the page's scope, since a component cannot change
  its props.
- **The badge tells the truth.** `$meta.samples.live` is the state of the stream that feeds the
  resource: `connecting`, `open` or `retrying`. Stop the server and the badge says "Reconnecting…"; start
  it again and it is "Live". The layout's `status` slot holds the badge.
- **Pause** is an optimistic `PATCH`: the card dims at once, and is restored if the server fails.
- **Busy states wait.** While the `PATCH` is out, sinter marks the button `aria-busy`, and while the page
  loads it shows a `Loading…` line marked the same. temper shows the spinner only after
  `--tm-busy-delay` (200ms), so a fast answer shows none. The demo server takes 400ms on purpose.

```sh
npm install
npm run dev
```

## Try this

- Open the page in two tabs and press **Pause** in one: the other follows (the server broadcasts it).
- Break it on purpose: change `s.latencyMs` to `s.latencyMss` in `index.html` and run
  `npm run build`: the build fails with the type error from the OpenAPI schema.
- Change `data-variant="ghost"` on the Pause button to `"danger"`: temper's check fails the build
  (and warns in dev). In dev, temper's inspector also audits the rendered page (overflow, contrast,
  clipped text) and prints findings in the terminal.
- Change `--tm-hue` in `src/style.css`: the graphs follow, in light and dark mode.

## Your own API

Remove `api()` from `vite.config.js` and proxy `/api` to your server; keep pointing `openapi` at its
spec file.
