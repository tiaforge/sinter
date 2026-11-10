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
| `src/components/` | header, footer, article meta, byline, preview, error list, favorite button (each page declares the `user` resource the header reads); `patch(article, …)` in the favorite button acts on the article where each use got it | |
| `src/sinter.config.js` | JWT middleware (`localStorage.jwtToken`), current-user error handling | |
| `src/islands.js` | sign-in/out (clearing the page-load cache) and navigation events, `<conduit-redirect>`, `window.__conduit_debug__` | |
| `src/markdown.js` | `<conduit-markdown>` (marked + DOMPurify, requested when the module runs; `rendered` once the body is in, and `public/styles.css` keeps what follows it out of the layout until then: no shift), loaded by `article.html` only | |
| `vite.config.js` | page entries, the dev/preview rewrites for the path patterns, `sinter({ openapi, origins })` (the API's origin: allowed on every page, its requests start before the stylesheets) | |
| `openapi.yml` | the Conduit API spec ([realworld-apps/realworld](https://github.com/realworld-apps/realworld), MIT), which types every resource for `npx sinter check` | |

Everything the pages' expressions cannot do (storage, navigation, HTML rendering) lives in the
config module and the islands (`src/markdown.js` too); the pages are declarative.

Every resource has `cache`: a page shows what the previous page loaded at once and revalidates.
Signing in or out calls `clearPersisted()`, since the cached data belongs to the previous identity.
Cached data does not set `$meta.<name>.loadedAt`, which stays null until the server answers (the
login-redirect guards read it).

## Form errors

No form has a `data-sn-catch`: each has an `<error-list data-sn-prop="{ error: $error }">`, its `.error-messages` list
reading `$error` (the form's last failed send) with the `errors()` helper's lines, and
`fieldErrors: () => null` in `src/sinter.config.js` marks no field, as the reference markup does. The
pages with a form load the fields module (1.1 KB gzip).

The buttons (favorite, follow, delete) have no catch either: a failed action without one bubbles
`sn-error`, and one handler on each page's root (home, profile, article) sends a 401 to the login page
and shows anything else in the page's `.error-messages` list (`<error-list data-sn-prop="{ error }">`). Deleting a
comment keeps its catch: it fills the comments' own list (`commentError`). The comment form's list
sits inside its card, so `public/styles.css` pads it like the textarea (the one rule of ours next to
the theme's comment-form rules).

Follow/unfollow and comment deletion wait for the server; favorites are optimistic.

## e2e suite

The suite runs in `spa` mode by default (this app holds the token and calls the API from the
browser). Against a local backend, `spa` passes all but five tests and `ssr` (`TEST_MODE=ssr`)
all but one; the rest of `ssr` is skipped by the suite. The failures are assumptions in the suite,
not app behavior:

- **Settings (4, `spa` only):** the `spa` branch keeps using the settings page after the PUT: three
  tests read the response body over CDP, one calls `page.evaluate` right away. This app redirects to
  the profile with a page load as soon as the PUT succeeds, which drops the body
  (`Network.getResponseBody: No resource`) and the JS context (`Execution context was destroyed`).
  The `ssr` branch of the same tests (wait for the profile, check the bio) passes.
- **Null/Empty Image and Bio Handling, "author avatars should render on other user articles in
  feed" (`spa`):** it reads the author of every `.article-preview`, and the home page's "Loading
  articles..." line is one too: reloading into the cached feed (`cache`) shows 10 articles and that
  line while it revalidates, so the test counts 11 and times out on the 11th. It also needs a
  backend with 10 or more articles, which the suite leaves behind.

With the mocked API (no backend), `error-handling` and `user-fetch-errors` pass except "should handle
403 when deleting another users comment", where the trash icon is not visible, probably because the
ionicons stylesheet from `code.ionicframework.com` cannot load without network access to it.

In a full run, a test or two can time out in `page.goto` (10 s) under load and pass when run alone.

## Against a local backend

```sh
# a spec-compliant backend, e.g. https://github.com/c4ffein/realworld-django-ninja, on :8000:
#   DEBUG=True .venv/bin/python manage.py migrate && DEBUG=True .venv/bin/python manage.py runserver 8000
API=http://localhost:8000/api CHROME=/path/to/chrome ./e2e-local.sh
```

`e2e-local.sh` seeds the demo users the suite expects (`johndoe`, `janedoe`), builds a copy of the
app pointing at `$API` (its `sinter({ origins })` in `vite.config.js` and its `openapi.yml`, whose
operations are matched under the spec's `servers` URL), points the specs that hardcode
`https://api.realworld.show` for their route mocks (`error-handling`, `user-fetch-errors`,
`health`) at `$API` in that copy, runs the suite and leaves `test-results/` behind.

The backend must answer invalid tokens with `401`. realworld-django-ninja needs `psycopg2-binary`
(its code imports `psycopg2`, which does not build without PostgreSQL headers) and an exception
handler that turns jwt_ninja's `APIError` into its 401 (unhandled, it is a 500).

The public API (`npm run e2e`) is slower and intermittently answers without CORS headers under
load, so runs against it vary by a few tests.
