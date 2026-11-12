# Service dashboard

[![Open in StackBlitz](https://developer.stackblitz.com/img/open_in_stackblitz.svg)](https://stackblitz.com/github/tiaforge/sinter/tree/main/examples/dashboard)

Four services with made-up metrics, live. One HTML page, no framework, no store:

- **The backend describes itself.** `server/openapi.yml` is the API's OpenAPI file; `server/api.js`
  serves it at `/api/openapi.yml` and implements it. The frontend reads the same file at build
  time (`sinter({ openapi })`), so `<sn-resource src="/api/services">` needs no `type`: it is
  `listServices`.
- **The numbers are pushed.** `server/api.js` makes them up (a random step per service, now and then a
  slow, failing spell). Every second the server sends a `service_updated` event per running
  service (`/api/events`); `<sn-sync>` in `index.html` upserts it by `id`.
- **The graphs are bindings.** The big chart and each sparkline are one component, `<spark-line>`:
  SVG whose `points` a helper (`line()`, `area()` in `src/sinter.helpers.ts`) computes from the
  samples. No chart library, no component script.
- **Layout and components.** `index.html` is one `<app-layout>` tag (`src/layouts/app-layout.html`:
  the head and the header). `<stat-tile>`, `<spark-line>` and `<service-card>` are plain HTML files in
  `src/components/`, expanded at build time, so they are in the first frame and never hydrate. The Pause
  button is slot content: the page's own markup, in the page's scope, since a component cannot change
  its props.
- **Pause** is an optimistic `PATCH`: the card dims at once, and is restored if the server fails.

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
