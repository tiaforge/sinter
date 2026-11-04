# RealWorld (Conduit) with sinter

The [RealWorld](https://github.com/gothinkster/realworld) "Conduit" frontend as a multi-page sinter
app, talking to the public API at `https://api.realworld.show/api`.

```sh
npm install            # in the repo root first: npm run build
npm run dev            # http://localhost:5173
npm run build && npm run preview
CHROME=/path/to/chrome npm run e2e   # the official e2e suite (e2e/, unchanged)
```

## Layout

| File | Page | Paths (`data-sn-path`) |
| --- | --- | --- |
| `index.html` | home: global feed, your feed, tag filter, pagination, popular tags | `/`, `/tag/:tag` |
| `article.html` | article, Markdown body, comments | `/article/:slug` |
| `profile.html` | profile, follow, my/favorited articles | `/profile/:username`, `/profile/:username/:tab` |
| `editor.html` | new / edit article | `/editor`, `/editor/:slug` |
| `settings.html` | user settings, logout | `/settings` |
| `login.html`, `register.html` | auth | `/login`, `/register` |
| `partials/` | header (declares the `user` resource), footer, article meta, preview, errors | |
| `src/sinter.config.js` | origin allowlist, JWT middleware (`localStorage.jwtToken`), current-user error handling | |
| `src/islands.js` | sign-in/out and navigation events, `<conduit-redirect>`, `<conduit-markdown>` (marked + DOMPurify), `window.__conduit_debug__` | |
| `vite.config.js` | page entries and the dev/preview rewrites for the path patterns | |

Everything the pages' expressions cannot do (storage, navigation, HTML rendering) lives in the
config module and the islands; the pages are declarative.

## e2e status (2026-11-04)

130–133 of 140 tests pass, depending on the run. The rest:

- **Settings (4)**: after "Update Settings" the app navigates to the profile (as the suite
  expects), but the tests read the PUT response body afterwards; in a multi-page app the
  navigation discards it (`Network.getResponseBody: No resource`). The suite assumes an SPA here.
- **Optimistic updates vs. immediate navigation (1–2)**: follow/delete show the result before the
  server answers; tests that navigate or end within milliseconds race the write (the write itself
  is sent with `keepalive` and is not lost).
- **Backend under load (2–8, varies)**: the public API intermittently answers article lists
  without CORS headers (seen in traces as `blocked by CORS policy`); the app then shows its
  "Connecting…" / "cannot be loaded" states. These tests pass when run alone.
