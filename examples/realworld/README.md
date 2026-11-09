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
| `src/sinter.config.js` | JWT middleware (`localStorage.jwtToken`), current-user error handling | |
| `src/islands.js` | sign-in/out (clearing the page-load cache) and navigation events, `<conduit-redirect>`, `<conduit-markdown>` (marked + DOMPurify), `window.__conduit_debug__` | |
| `vite.config.js` | page entries, the dev/preview rewrites for the path patterns, `sinter({ openapi, origins })` (the API's origin: allowed on every page, its requests start before the stylesheets) | |
| `openapi.yml` | the Conduit API spec ([realworld-apps/realworld](https://github.com/realworld-apps/realworld), MIT), which types every resource for `npx sinter check` | |

Everything the pages' expressions cannot do (storage, navigation, HTML rendering) lives in the
config module and the islands; the pages are declarative.

Every resource has `cache`: a page shows what the previous page loaded at once and revalidates.
Signing in or out calls `clearPersisted()`, since the cached data belongs to the previous identity.
Run alongside the e2e suite, this found that cached data must not set `$meta.<name>.loadedAt`
(the login-redirect guards read it); sinter now leaves it null until the server answers.

## Form errors

Login, register, settings and the editor have no `data-sn-catch`: one `fieldErrors` hook in
`src/sinter.config.js` puts every server error, as the `errors()` helper writes it, into the form's
`<ul class="error-messages" data-sn-errors="…">`, and marks no field, as the reference markup does. The
buttons (favorite, follow, delete) keep their catches (a 401 goes to the login page), and so does the
comment form, until the article page's size budget has room for the fields module (0.4 KB short).
With the mocked API (no backend), 2026-11-09: `error-handling` and `user-fetch-errors` 44 passed,
1 failed ("should handle 403 when deleting another users comment": the trash icon is not visible; it
fails the same way on `main`, probably the ionicons stylesheet, which a container without access to
`code.ionicframework.com` cannot load).

## e2e status (2026-11-09, local backend)

2026-11-09, `spa`, after early requests to the API's origin, the split early file and Google Fonts
inlining: 135 passed, 5 failed, 5.6 minutes (Chromium 153 in a cloud container). The four Settings
failures below, and one more: **Null/Empty Image and Bio Handling, "author avatars should render on
other user articles in feed"** reads the author of every `.article-preview`, and the home page's
"Loading articles..." line is one too: reloading into the cached feed (`cache`) shows 10 articles and
that line while it revalidates, so the test counts 11 and times out on the 11th. It failed 10 of 10
alone on this commit, 10 of 10 on the merged `main` before it and 5 of 5 on 35f2c9c (before the
Lighthouse and image work): not from these changes; it needs a backend with 10 or more articles,
which the suite leaves behind. The backend: realworld-django-ninja on SQLite with `psycopg2-binary`
(`psycopg2` does not build without PostgreSQL headers; the code imports it), and an exception
handler that answers jwt_ninja's `APIError` with its 401 (unhandled, it was a 500).
`e2e-local.sh` now also points `sinter({ origins })` in the copy's `vite.config.js` at `$API`'s origin.

### 2026-11-08

Against [realworld-django-ninja](https://github.com/c4ffein/realworld-django-ninja) on SQLite
(see below), with its invalid-token responses fixed to 401 (upstream answers them with a 500):

| suite mode | passed | skipped | failed |
| --- | ---: | ---: | ---: |
| `spa` (default; this app holds the token and calls the API from the browser) | 136 | 0 | 4 |
| `ssr` (`TEST_MODE=ssr`) | 91 | 48 | 1 |

2026-11-08, `spa`, after write-through replaced 12 `then` handlers (favorites, follow, comments):
136 passed, the four Settings failures below remain, 6.2 minutes on the Steam Deck with the flatpak
Chrome (`CHROME` is a one-line wrapper, `exec flatpak run com.google.Chrome "$@"`; `TMPDIR` must be
under `$HOME`, since the sandbox cannot see a profile in `/tmp`). The copy's `openapi.yml` is pointed
at `$API` too: operations are matched under the spec's `servers` URL, so without that the build is
untyped and write-through has nothing to apply (the first run after the change failed 12 tests that
way). Earlier (2026-11-05): the same five failures as above; in a full run, one or two tests more
can time out in `page.goto` (10 s) under load, and pass when run alone. `ssr` mode was not rerun.

The remaining failures are assumptions in the suite, not app behaviour:

- **Settings (4, spa mode only)**: the spa branch keeps using the settings page after the PUT:
  three tests read the response body over CDP, one calls `page.evaluate` right away. This app
  redirects to the profile with a page load as soon as the PUT succeeds, which drops the body
  (`Network.getResponseBody: No resource`) and the JS context (`Execution context was
  destroyed`). The ssr branch of the same tests (wait for the profile, check the bio) passes.
- **Comments, "should require login to post comment" (both modes, fixed 2026-11-08, passes since)**: asserts on the strict locator `a[href="/login"]`, which matched the nav link and the
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
