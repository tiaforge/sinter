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

## e2e status (2026-11-04, public API)

| suite mode | passed | skipped | failed |
| --- | ---: | ---: | ---: |
| `spa` (default; this app holds the token and calls the API from the browser) | 134 | 0 | 6 |
| `ssr` (`TEST_MODE=ssr`) | 89 | 48 | 3 |

- **Settings (4, spa mode only)**: after "Update Settings" the app navigates to the profile, as
  the suite expects, but spa mode then reads the PUT response body, which a multi-page app
  discards on navigation. The ssr-mode branch of the same tests (wait for the redirect, check
  the profile) passes.
- **Profile lists (2)**: the public API answers authenticated article lists for a user with two
  fresh articles without CORS headers (seen in traces); fails in both modes.
- ssr mode's other 2 failures were registrations that timed out against the public API.

Follow/unfollow and comment deletion wait for the server; favorites are optimistic.

## Against a local backend

```sh
# a spec-compliant backend, e.g. https://github.com/c4ffein/realworld-django-ninja, on :8000
API=http://localhost:8000/api CHROME=/path/to/chrome ./e2e-local.sh
```

`e2e-local.sh` seeds the demo users the suite expects (`johndoe`, `janedoe`), builds a copy of the
app pointing at `$API`, and runs the suite. `user-fetch-errors.spec.ts` mocks
`https://api.realworld.show` itself and cannot pass against another backend.
