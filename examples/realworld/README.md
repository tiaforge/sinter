# RealWorld (Conduit) with sinter

The [RealWorld](https://github.com/gothinkster/realworld) "Conduit" frontend as a multi-page sinter
app, talking to the public API at `https://api.realworld.show/api`.

A running copy: **https://realworld.tiaforge.dev** (the [server image](#the-server-as-an-image) below, with each page's data in its HTML).

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
| `src/sinter.config.js` | the suite's current-user rules (a response-only middleware: any 4xx from `GET /user` signs out, an empty 200 is an error) | |
| `src/islands.js` | `window.__conduit_debug__` | |
| `vite.config.js` | page entries, the dev/preview rewrites for the path patterns, `sinter({ apis })` | |
| `apis.js` | the API (`sinter({ apis })`): its spec, what each endpoint returns and its token (`localStorage.jwtToken`, sent as `Authorization: Token …`, stored from sign-in, sign-up and settings); pages write paths (`src="/articles"`), its origin is allowed on every page and its requests start before the stylesheets | |
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
The parser loads with the article page. `<md-doc>` builds the body with its script renderer (`<md-view>`), and with embedded
data its early renderer (`md-view.early.ts`, [early renderers](../../docs/components.md#early-renderers)) builds it in the first
paint with the rest of the article; the page module's instance keeps those elements. Without the early renderer the body came
in at mount and moved the comments below it (Lighthouse mobile through sinter-axum, 2026-11-22: CLS 0.444 and a score of 79;
with it CLS 0.001, 100, and LCP the first paint, as the components' `templates: true` had). The API has a `token`, so what sinter-axum embeds is the signed-out answer:
`openapi.yml` marks the article, comments, list and profile reads as optional (`security: [{}, { Token: [] }]`) and the tags
public, and a visitor with a token stored gets those from the API, with it (until 2026-11-22 the spec said neither, and
nothing was embedded). With embedded data (`SINTER_EMBED`), the body renders in the early script
like the rest of the article, so the parser is in the article's early file (30.7 kB gzip with the shared script, `firstPaint.budget` raised to
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

The build is strict (warnings fail it) and warns about nothing. Below 768 px the Conduit theme gives its grid
columns no width, so the feed's column and the tags' are only as wide as their content until their rows arrive;
the build keeps what follows each of them hidden while its first rows load
([a box whose width follows the list](../../docs/first-paint.md#a-box-whose-width-follows-the-list)), so nothing
shown moves, and `SN529`, which says it moves, has nothing to report. The "Loading articles..." and "Loading tags..." lines are in the first
frame ([first paint](../../docs/first-paint.md#loading-branches)).

Every resource has `cache`: a page shows what the previous page loaded at once and revalidates.
A token stored or removed (signing in or out) drops it, since the cached data belongs to the previous
identity. Cached data does not set `$meta.<name>.loadedAt`, which stays null until the server answers;
with no token stored, `user` is loaded at once, empty, without a request, so the header and the home banner
know `$meta.user.loadedAt && !user` (signed out) before the first paint. The editor and settings pages, and the
home page's own feed, need a session (`data-sn-signed-in`): a signed-out visitor goes to `/login` before
anything paints. That is a convenience; the API refuses their requests all the same.

## Form errors

No form has a `data-sn-catch`: each has an `<error-list data-sn-with="{ error: $error }">`, its `.error-messages` list
reading `$error` (the form's last failed send) with the `errors()` helper's lines, and
`fieldErrors: () => null` in `src/sinter.config.js` marks no field, as the reference markup does. The
pages with a form load the fields module (1.1 KB gzip).

The buttons (favorite, follow, delete) have no catch either: a failed action without one bubbles
`sn-error`: a 401 goes to the login page (the API's `token.signIn`), and one handler on each page's root (home, profile, article) shows anything else in the page's `.error-messages` list (`<error-list data-sn-with="{ error }">`). Deleting a
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
  saved user into `user` (`upsert`) and calls `navigate()` (the API's `token.from` stores the new token; the
  cache stays: the account is the same); the profile page shows the cached user at once and revalidates.
  Signing in, up and out navigate the same way.
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

## The server as an image

The app with its data in the page (built with `SINTER_EMBED=1`), served by sinter-axum's example server
(`packages/sinter-axum/examples/realworld.rs`), is published as an 8 MB image: one static binary, the app's files
and the CA certificates, on `scratch`, running as a non-root user.

```sh
docker run --rm -p 8080:8080 ghcr.io/tiaforge/sinter-realworld     # http://localhost:8080
```

It fetches each page's data from the public API (`api.realworld.show`) and writes it into the HTML, so the first
frame has the articles (the static build fetches them after the page loads: Lighthouse mobile LCP 1.9 s against
0.9 s). `PORT` (8080), `HOST` (0.0.0.0) and `API` (the origin the build names) set where it listens and what it
fetches from. It serves plain HTTP: put the host's TLS or a CDN in front (the server compresses with gzip). It embeds
the signed-out view only, so it is for the public demo and for measuring.

Build it from the repository's root: `docker build -f examples/realworld/Dockerfile -t sinter-realworld .`
(the `Dockerfile` builds sinter, the app and the server itself). The *RealWorld image* workflow
(`.github/workflows/realworld-image.yml`) publishes `latest` and the commit's short sha for amd64 and arm64
when the app, sinter or the server change on `main`; the package is private until it is made public in its
settings on GitHub.
