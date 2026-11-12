# Service dashboard

[![Open in StackBlitz](https://developer.stackblitz.com/img/open_in_stackblitz.svg)](https://stackblitz.com/github/tiaforge/sinter/tree/main/examples/dashboard)

Four services with made-up metrics, live. One HTML page, no framework, no store:

- **The backend describes itself.** `server/openapi.yml` is the API's OpenAPI file; `server/api.js`
  serves it at `/api/openapi.yml` and implements it. The frontend reads the same file at build
  time (`sinter({ openapi })`), so `<sn-resource src="/api/services">` needs no `type`: it is
  `listServices`.
- **The numbers are pushed.** Every second the server sends a `service_updated` event per running
  service (`/api/events`); `<sn-sync>` in `index.html` upserts it by `id`.
- **The graphs are bindings.** The big chart and each sparkline are SVG: a helper
  (`line()`, `area()` in `src/sinter.helpers.ts`) turns the samples into `points`. No chart
  library, no component script.
- **Pause** is an optimistic `PATCH`: the card dims at once, and is restored if the server fails.

```sh
npm install
npm run dev
```

## Try this

- Open the page in two tabs and press **Pause** in one: the other follows (the server broadcasts it).
- Break it on purpose: change `s.latencyMs` to `s.latencyMss` in `index.html` and run
  `npm run build`: the build fails with the type error from the OpenAPI schema.
- Change `--tm-hue` in `src/style.css`: the graphs follow, in light and dark mode.

## Your own API

Remove `api()` from `vite.config.js` and proxy `/api` to your server; keep pointing `openapi` at its
spec file.
