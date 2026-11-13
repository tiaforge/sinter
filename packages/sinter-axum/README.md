# sinter-axum

Serve a [sinter](https://github.com/tiaforge/sinter#readme) app from axum with its API data already in the page. The first frame shows the data, the browser makes no API request on load, and nothing is rendered on the server.

You add one layer. For each page, it calls your API and writes the JSON into the HTML as it's sent.

The server layer is optional: without it, sinter pages fetch their data in the browser. It is also easy to port to another language. The server only writes JSON into the `<script type="application/json" data-sn-data>` slots in the head of each page, which the build lists in `sinter-embed.json` ([contract](https://github.com/tiaforge/sinter/blob/main/docs/first-paint.md)).

## Quick start

**1. Build the frontend for a server.** In its Vite config, `sinter({ embed: true })` (needs `@tiaforge-ui/sinter` 0.13 or newer). The build then leaves an empty data slot in each page for every resource whose request the page's URL decides, and lists them in `dist/sinter-embed.json`. The browser no longer requests those itself: their data comes with the page.

**2. Add the crate.**

```toml
[dependencies]
sinter-axum = "0.17"
```

**3. Add the layer** in front of the static files, and give it your API router:

```rust
use axum::{Router, routing::get, serve::ListenerExt};
use tower_http::{compression::CompressionLayer, services::ServeDir};

let api = Router::new().route("/api/articles", get(articles));

let embed = sinter_axum::embed!("../web/dist", {});   // checked against the build when this compiles

let app = Router::new()
    .merge(api.clone())
    .fallback_service(ServeDir::new("dist"))
    .layer(embed.api(api).build()?)
    .layer(CompressionLayer::new());

let listener = tokio::net::TcpListener::bind("0.0.0.0:3000").await?
    // the page is sent in two parts (head first, then the data); without this the second part can wait ~40 ms
    .tap_io(|tcp| { let _ = tcp.set_nodelay(true); });
axum::serve(listener, app).await?;
```

For each page request, the layer calls your router in-process, passing on the request's cookies. Other requests pass through untouched.

`CompressionLayer` compresses with `flate2`, whose default backend is miniz_oxide. With zlib-ng (`flate2 = { version = "1", features = ["zlib-ng"] }` in your dependencies, which needs CMake to build), the same gzip took half the CPU per page in the [measurements](https://github.com/tiaforge/sinter/blob/main/docs/first-paint-comparison.md#with-the-api-in-the-same-app).

The page is sent head first, before the data is in, so its status is `200` from the start. If the data then can't be fetched, the rest of the page isn't sent: the response ends with an error text, or a redirect to your error page (see [What the layer does](#what-the-layer-does)).

## The compile-time check

`embed!` reads the build's `sinter-embed.json` when your crate compiles; the path is relative to your `Cargo.toml`. It's a compile error when the build has a slot your configuration can't fill, and the error names the page, the resource and the fix:

```text
error: index.html: `articles`: the build could not describe its request (its `src` or `start-page`
       calls a helper, or reads something other than `$url`). Add `"articles" => |req| async move { … }`
       to give its data, or `"articles" => skip` to leave it to the browser
```

A name that no slot has (a typo) is an error too. A name applies to every page; `"profile.html:articles"` names one page's slot.

The manifest is compiled into the binary. At startup, `build()` refuses a `dist/` from a different build, so the frontend and the server can't drift apart. If the pages are somewhere else at run time, say so with `.dir("/srv/dist")`.

Without the macro, `Embed::from_dir("dist")` does the same checks in `build()` at startup and returns them all in one error.

## Where the data comes from

The build records each page's API requests, including the first page of a paginated list and simple `when` conditions on the URL, so you usually only say how to reach the API:

| Your API | Configure | Needs the `upstream` feature |
| --- | --- | --- |
| Routes in the same axum app | `.api(router)`, as above | no |
| A separate server, called by the frontend at same-origin paths (`/api/...`) | `.upstream("http://127.0.0.1:4000")` | yes |
| Another origin, called by the frontend at absolute URLs (`https://api.example.com/...`) | `.allow_origin("https://api.example.com")` | yes |

`build()` also checks this: a same-origin path with neither `.api` nor `.upstream`, or an origin not allowed, is an error at startup. The `upstream` feature adds an HTTP client (reqwest, with rustls). You need it only for the two rows that call another server:

```toml
sinter-axum = { version = "0.17", features = ["upstream"] }
```

### Resolvers: your own code for one resource

A resolver is an async Rust function you register for one resource; it produces that resource's data instead of the layer making the request. It needs no HTTP client: it usually calls the same code as your API handler, such as a database query.

You need one when the build can't describe the request: the frontend's `src` calls a helper or chooses between parameters with a ternary, or its `when` is more than a comparison of URL values with strings. The compile-time check tells you which ones.

A resolver receives a `SlotRequest` with:

- `params`: the page URL's parameters: query parameters and named path segments (`/article/:slug` gives `slug`);
- `headers`: the page request's headers;
- `url`: the URL the layer would request, if the build describes one;
- `page`, `resource`: which slot it is.

It returns the JSON body the API would have returned, as `Option<Bytes>`. `None` leaves the resource to the browser.

```rust
// the API handler and the resolver share one function
async fn load_articles(user: &str, page: u64) -> anyhow::Result<ArticleList> { /* query the database */ }

let embed = sinter_axum::embed!("../web/dist", {
    "profile.html:articles" => |req| async move {
        let page = sinter_axum::to_page(req.params.get("page").map(String::as_str));
        let list = load_articles(req.params.get("username")?, page).await.ok()?;
        serde_json::to_vec(&list).ok().map(Into::into)
    },
});
```

A resolver takes precedence over the automatic request, so you can also use one to skip the HTTP round trip for a resource the build does describe.

## Signed-in users

The layer fetches the data before any of the page's JavaScript runs, so the API sees only what the browser sent with its request for the page. The page uses the embedded data as is and doesn't request it again on load, so what the API returns here is what the user sees.

Which case are you in?

1. **The data is the same for everyone** (public articles, tags). Nothing to do.
2. **The data is per user, and the session is a cookie.** Nothing to do. The browser's request for the page includes the session cookie, and the layer passes it on to `.api` and `.upstream`, so your API sees the same user. Requests to `.allow_origin` URLs get no cookies, as sinter's own requests to another origin don't either.
3. **The data is per user, and the frontend sends a token from JavaScript** (kept in `localStorage`, sent as `Authorization`). The request for the page doesn't include the token, so the API would answer as if signed out, and a signed-in user would see signed-out data on every page load. Leave these resources to the browser:
   - in the frontend, `early="off"` on the resource. It already means "a request middleware changes this request", so the build gives it no slot;
   - or on the server, `"articles" => skip`.

Pages are sent with `Cache-Control: private, no-cache`, so a shared cache never gives one user's page to another.

## Options

| Option | Default |
| --- | --- |
| `.timeout(Duration)`: how long a page waits for all its data | 500 ms |
| `.forward([headers])`: the page request's headers passed on to `.api` and `.upstream` | `Cookie`, `Authorization`, `Accept-Language` |
| `.max_bytes(n)`: the largest response put into a page | 2 MiB |
| `.stream(false)`: send each page in one piece instead of head first; a failure is then a real `502` (`504` on the time limit) | head first |
| `.error_text(text)`: sent instead of the rest of a page whose data failed | `Error, please retry later.` |
| `.error_redirect(url)`: where the browser goes then (a `meta` refresh and `location.replace`); serve that page with an error status | none |
| `.cache_control(value)`: the pages' `Cache-Control` header | `private, no-cache` |
| `.dir(path)`: where the pages are at run time | the path given to `embed!` |

## What the layer does

- **At startup (`build()`):** it reads `sinter-embed.json`, checks that every slot has a source, and splits each page at its slots. The slots are the last thing in the page's `<head>`, after the stylesheets and scripts.
- **On a GET for a page:**
  - it sends the HTML up to the first slot right away, so the browser loads stylesheets and scripts while the data is fetched;
  - it fetches every slot's data in parallel, for this URL: the URL's values in the request, the page a paginated list starts at, and no request when the resource's `when` doesn't hold;
  - it writes the data, with `<` escaped so it can't break out of its `<script>`, then the rest of the page.
- **When a slot's data can't be fetched** (the API errors or can't be reached, a non-2xx or non-JSON response, one over `max_bytes`, the time limit), the page is not sent: the layer ends the response there with the error text in the page's body, marked so the page's scripts don't start, and with `.error_redirect(url)` sends the browser to your error page. A 404 from the API counts too, so a missing article shows the error text, not the page's own not-found state.
- **The site's URLs:** it follows the same rules as the build's `_redirects`, which it reads from the manifest: a permanent redirect from a page's old file URL (`/about.html` to `/about/`, with the query), and a path a page declares in `data-sn-path` (`/article/hello`) answered from that page's file, with its data written in, or passed to the inner service as that file. So the app needs no routes of its own for its pages ([page URLs](../../docs/static-pages.md#page-urls)).
- **No data is not a failure:** a resolver's `None`, a `skip`, or a `when` that doesn't hold leaves the slot empty, and the browser requests that data itself.
- **What it never does:** fetch a URL whose host comes from the page's URL, or serve `sinter-embed.json` (it answers 404).

## What the browser receives

For the frontend, a resource is just a resource:

```html
<sn-resource name="articles" src="/api/articles?tag={$url.tag}" key="slug" items="articles"></sn-resource>
```

With `embed: true`, the build gives it an empty slot at the end of the head and lists its request in `sinter-embed.json`:

```html
<!-- dist/index.html -->
<script type="application/json" data-sn="0"></script>
```

```json
{ "id": 0, "resource": "articles", "src": ["/api/articles?tag=", { "url": "tag" }] }
```

For a request to `/?tag=rust`, the layer requests `/api/articles?tag=rust` from your API and writes the response body into the slot:

```html
<script type="application/json" data-sn="0">{"articles":[{"slug":"hello","title":"Hello"}],"articlesCount":1}</script>
```

The body goes in exactly as the API returned it (`items="articles"` picks the list out of it in the browser), except that every `<` is escaped. The bindings over it, rows included, render while the page is parsed.

## Performance

Latency and throughput numbers, with the method, are in [docs/first-paint-comparison.md](https://github.com/tiaforge/sinter/blob/main/docs/first-paint-comparison.md).

To run the RealWorld server used there (frontend built with `SINTER_EMBED=1`):

```sh
cargo run --release --features upstream --example realworld -- ../../examples/realworld/dist 4370 http://localhost:4400
```
