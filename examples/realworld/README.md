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
| `article.html` | article, Markdown body (`<md-doc>` over `md.parse(article.body)`, [@tiaforge-ui/sinter-markdown](../../packages/sinter-markdown)), comments | `/article/:slug` |
| `profile.html` | profile, follow, my/favorited articles | `/profile/:username`, `/profile/:username/:tab` |
| `editor.html` | new / edit article | `/editor`, `/editor/:slug` |
| `settings.html` | user settings, logout | `/settings` |
| `login.html`, `register.html` | auth | `/login`, `/register` |
| `src/layouts/conduit-layout.html` | the document every page shares: the head, the header and the footer; each page is its tag, with its state, its handlers and its title and description as props | |
| `src/components/` | header, footer, `conduit-seo` (the head component for the title and description), article meta, byline, preview, error list, favorite button (each page declares the `user` resource the header reads); `merge(article, …)` in the favorite button acts on the article where each use got it | |
| `src/sinter.config.js` | JWT middleware (`localStorage.jwtToken`), current-user error handling | |
| `src/islands.js` | sign-in/out (clearing the page-load cache) and navigation events, `<conduit-redirect>`, `window.__conduit_debug__` | |
| `vite.config.js` | page entries, the dev/preview rewrites for the path patterns, `sinter({ apis })` | |
| `apis.js` | the API (`sinter({ apis })`): its spec and what each endpoint returns; pages write paths (`src="/articles"`), its origin is allowed on every page and its requests start before the stylesheets | |
| `openapi.yml` | the Conduit API spec ([realworld-apps/realworld](https://github.com/realworld-apps/realworld), MIT), which types every resource for `npx sinter check` | |

Everything the pages' expressions cannot do (storage, navigation) lives in the config module and the
islands; the pages are declarative.

The article's body is Markdown, rendered by the markdown library: `src/sinter.helpers.js` re-exports it as
`md`, `vite.config.js` lists it in `components`, and `article.html` writes
`<md-doc data-sn-with="{ doc: md.parse(article.body) }">`. It renders with the article, in the same frame,
so nothing after the body moves when it comes in. Raw HTML in a body shows as text (`md.parse`'s default,
`html: 'text'`), and sinter refuses a link's or an image's `javascript:` URL (it renders without it): the XSS
suite's payloads stay inert. Until 2026-11-17 the body was marked and DOMPurify in an island,
`<conduit-markdown>`; the comparison is in the [markdown library's docs](../../packages/sinter-markdown/docs/markdown.md#performance).
The parser loads with the article page. With embedded data (`SINTER_EMBED`), the body renders in the early script
like the rest of the article, so the parser is in the article's early file (30.5 kB gzip, `earlyBudget` raised to
40 KB in `vite.config.js`), and the page module takes that instance instead of a copy of its own
([own copies](../../docs/first-paint.md#own-copies)). Measured on the article page (Lighthouse mobile, a local
API, median of 5):

| | static | sinter-axum: first paint / LCP |
| --- | ---: | ---: |
| marked + DOMPurify, before | 2,412 ms | 1,410 / 2,129 ms |
| sinter-markdown, the body in the early script | 2,389 ms | 1,359 / **1,359** ms |
| sinter-markdown, the body at mount (`<md-doc data-sn-early="off">`) | | 1,354 / 2,127 ms |
| sinter-markdown, the parser lazy | 2,566 ms | 1,440 / 2,266 ms |

Until the page module shared the early file's parser (2026-11-17), the body in the first frame cost the parser twice:
91.8 kB of scripts transferred (brotli); now 67.2 kB, with 49 ms of blocking time instead of 70 and the same LCP
(Lighthouse mobile through sinter-axum, median of 9; a swap into the article, which runs no early file, loads the
parser's own chunk beside the page module: 857 ms from the click to the body instead of 958 on slow 4G).
At mount, what follows the body needed CSS to hold it back (CLS 0.452 without); in the first frame it needs none.
The library is linked from `packages/` (`file:`), so `resolve.dedupe` in `vite.config.js` points its imports
of sinter at the app's.

The article lists keep their page in the URL with `model: $url.page` in their `paginate`: `?page=3` (or a reload,
or Back) loads the third page, in the early request and the embedded data too. The pager's links
and the home page's feed tabs are plain links that stay on the page when clicked
([same-page links](../../docs/navigation.md#same-page-links)): a new history entry and the list's
next page, no reload. "Global Feed" from `/tag/go` is another path: the home page is swapped in ([swaps](../../docs/navigation.md#swaps)). The active page is
`$meta.<name>.page`, the page shown.

The build warns twice, `SN529`, and the warnings stay: below 768 px the Conduit theme gives its grid
columns no width, so the feed's column is only as wide as its content and the tags sit beside it
until the articles arrive. That layout shift (0.15 on a phone, with the API answering after 500 ms;
0.035 with the columns at full width) is the theme's, which every RealWorld implementation shares,
so the theme stays as it is. The build is strict (warnings fail it) with `SN529` allowed, by name and
with the reason, in `vite.config.js`. The "Loading articles..." and "Loading tags..." lines are in the first
frame ([first paint](../../docs/first-paint.md#loading-branches)).

Every resource has `cache`: a page shows what the previous page loaded at once and revalidates.
Signing in or out calls `clearPersisted()`, since the cached data belongs to the previous identity.
Cached data does not set `$meta.<name>.loadedAt`, which stays null until the server answers (the
login-redirect guards read it).

## Form errors

No form has a `data-sn-catch`: each has an `<error-list data-sn-with="{ error: $error }">`, its `.error-messages` list
reading `$error` (the form's last failed send) with the `errors()` helper's lines, and
`fieldErrors: () => null` in `src/sinter.config.js` marks no field, as the reference markup does. The
pages with a form load the fields module (1.1 KB gzip).

The buttons (favorite, follow, delete) have no catch either: a failed action without one bubbles
`sn-error`, and one handler on each page's root (home, profile, article) sends a 401 to the login page
and shows anything else in the page's `.error-messages` list (`<error-list data-sn-with="{ error }">`). Deleting a
comment keeps its catch: it fills the comments' own list (`commentError`). The comment form's list
sits inside its card, so `public/styles.css` pads it like the textarea (the one rule of ours next to
the theme's comment-form rules).

Follow/unfollow and comment deletion wait for the server; favorites are optimistic.

## e2e suite

The suite runs in `spa` mode by default (this app holds the token and calls the API from the
browser). Against a local backend (realworld-django-ninja, `e2e-local.sh`, 2026-11-16) `spa` passes all
140 tests with swaps on; with page loads instead (before swaps) it passed 136, failing the four settings
tests below, and `ssr` (`TEST_MODE=ssr`) all but one, before the fixes below; the rest of `ssr` is
skipped by the suite. The failures were assumptions in the suite, not app behavior:

- **Settings (4, `spa` only), fixed by swaps:** the `spa` branch keeps using the settings page after the
  PUT: three tests read the response body over CDP, one calls `page.evaluate` right away, and they read
  the current user at once. A redirect to the profile with a page load drops the body
  (`Network.getResponseBody: No resource`) and the JS context (`Execution context was destroyed`). With
  `sinter({ swap: true })` (vite.config.js) a link or `navigate()` swaps the next page in, in the same
  document ([docs/navigation.md](../../docs/navigation.md#swaps)). The settings form's `then` writes the
  saved user into `user` (`upsert`), stores the token (`settings-saved` in `src/islands.js`, which keeps
  the cache: the account is the same) and calls `navigate()`; the profile page shows the cached user at
  once and revalidates. Every redirect goes the same way: the islands call `navigate` from
  `@tiaforge-ui/sinter` for signing in and out, and `<conduit-redirect>` calls it with `replace: true`.
  Against the shared public API, a run now and then shows another account right after registering
  (`pw` and the time in base 36, `John Doe`, `www.google.com:80/`: other clients' accounts), on paths
  with and without swaps: the API answers a new account's token with another account. Run against a
  local backend (`e2e-local.sh`) for a clean result.
- **Null/Empty Image and Bio Handling, "author avatars should render on other user articles in
  feed":** it reads the author of every `.article-preview`, the "Loading articles..." line included.
  That line now shows only while there is nothing to show (with cached articles, loading means
  updating them), so a reload into the cached feed counts 10. It needs a backend with 10 or more
  articles, which the suite leaves behind. Not run since this change.

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
app pointing at `$API` (the `servers` URL of its `openapi.yml`, which is the API's base in `apis.js`), points the specs that hardcode
`https://api.realworld.show` for their route mocks (`error-handling`, `user-fetch-errors`,
`health`) at `$API` in that copy, runs the suite and leaves `test-results/` behind.

The backend must answer invalid tokens with `401`. realworld-django-ninja needs `psycopg2-binary`
(its code imports `psycopg2`, which does not build without PostgreSQL headers) and an exception
handler that turns jwt_ninja's `APIError` into its 401 (unhandled, it is a 500).

The public API (`npm run e2e`) is slower and intermittently answers without CORS headers under
load, so runs against it vary by a few tests.
