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
| `src/islands.js` | sign-in/out (clearing the page-load cache) and navigation events, `<conduit-redirect>`, `<conduit-markdown>` (marked + DOMPurify), `window.__conduit_debug__` | |
| `vite.config.js` | page entries, the dev/preview rewrites for the path patterns, `sinter({ openapi })` | |
| `openapi.yml` | the Conduit API spec ([realworld-apps/realworld](https://github.com/realworld-apps/realworld), MIT), which types every resource for `npx sinter check` | |

Everything the pages' expressions cannot do (storage, navigation, HTML rendering) lives in the
config module and the islands; the pages are declarative.

Every resource has `cache`: a page shows what the previous page loaded at once and revalidates.
Signing in or out calls `clearPersisted()`, since the cached data belongs to the previous identity.
Run alongside the e2e suite, this found that cached data must not set `$meta.<name>.loadedAt`
(the login-redirect guards read it); sinter now leaves it null until the server answers.

## e2e status (2026-11-05, local backend)

Against [realworld-django-ninja](https://github.com/c4ffein/realworld-django-ninja) on SQLite
(see below), with its invalid-token responses fixed to 401 (upstream answers them with a 500):

| suite mode | passed | skipped | failed |
| --- | ---: | ---: | ---: |
| `spa` (default; this app holds the token and calls the API from the browser) | 135 | 0 | 5 |
| `ssr` (`TEST_MODE=ssr`) | 91 | 48 | 1 |

With `cache` on every resource (2026-11-05, `spa`): the same five failures; in a full run, one or
two tests more can time out in `page.goto` (10 s) under load on a slow machine, and pass when run
alone. `ssr` mode was not rerun.

The remaining failures are assumptions in the suite, not app behaviour:

- **Settings (4, spa mode only)**: the spa branch keeps using the settings page after the PUT:
  three tests read the response body over CDP, one calls `page.evaluate` right away. This app
  redirects to the profile with a page load as soon as the PUT succeeds, which drops the body
  (`Network.getResponseBody: No resource`) and the JS context (`Execution context was
  destroyed`). The ssr branch of the same tests (wait for the profile, check the bio) passes.
- **Comments, "should require login to post comment" (both modes, fixed 2026-11-08, not yet
  rerun)**: asserts on the strict locator `a[href="/login"]`, which matched the nav link and the
  reference markup's "Sign in or sign up to add comments" link once the article had loaded
  (against the slower public API the assertion ran before that, so it passed there). The
  article's link now carries the way back, `/login?next=/article/<slug>`, and the login page
  returns there after signing in (`$url.next`, accepted only as an absolute path on this origin).
  The nav link is the only `a[href="/login"]` left, so the test should pass in both modes.

Follow/unfollow and comment deletion wait for the server; favorites are optimistic.

## Against a local backend

```sh
# a spec-compliant backend, e.g. https://github.com/c4ffein/realworld-django-ninja, on :8000:
#   DEBUG=True .venv/bin/python manage.py migrate && DEBUG=True .venv/bin/python manage.py runserver 8000
API=http://localhost:8000/api CHROME=/path/to/chrome ./e2e-local.sh
```

`e2e-local.sh` seeds the demo users the suite expects (`johndoe`, `janedoe`), builds a copy of the
app pointing at `$API`, points the specs that hardcode `https://api.realworld.show` for their
route mocks (`error-handling`, `user-fetch-errors`, `health`) at `$API` in that copy, runs the
suite and leaves `test-results/` behind.

The public API (`npm run e2e`) is slower and intermittently answers without CORS headers under
load, so runs against it vary by a few tests.
