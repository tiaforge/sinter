# sinter-axum

Serve a [sinter](../../README.md) app from axum with its API data already in the page. The first frame shows the data, the browser makes no API request on load, and nothing is rendered on the server.

You add one layer. For each page, it calls your API and writes the JSON into the HTML as it's sent.

## Quick start

**1. Get the build.** The frontend's `vite build` produces a `dist/` directory. If any page has a data placeholder, `dist/` contains `sinter-embed.json`, which tells the layer which pages need which data. Without that file no page has a placeholder (see [For the frontend](#for-the-frontend)), and `Embed::from_dir` returns an error.

**2. Add the crate.**

```toml
[dependencies]
sinter-axum = "0.1"
```

**3. Add the layer** in front of the static files, and give it your API router:

```rust
use axum::{Router, routing::get, serve::ListenerExt};
use sinter_axum::Embed;
use tower_http::{compression::CompressionLayer, services::ServeDir};

let api = Router::new().route("/api/articles", get(articles));

let app = Router::new()
    .merge(api.clone())
    .fallback_service(ServeDir::new("dist"))
    .layer(Embed::from_dir("dist")?.api(api))
    .layer(CompressionLayer::new());

let listener = tokio::net::TcpListener::bind("0.0.0.0:3000").await?
    // the page is sent in two parts (head first, then the data); without this the second part can wait ~40 ms
    .tap_io(|tcp| { let _ = tcp.set_nodelay(true); });
axum::serve(listener, app).await?;
```

That's all. For each page request, the layer calls your router in-process, passing on the request's cookies. Other requests pass through untouched. If some data can't be fetched, the page is sent without it and the browser requests that data itself, as it would without the layer.

## Where the data comes from

The build records each page's API requests, so you usually only say how to reach the API:

| Your API | Configure | Needs the `upstream` feature |
| --- | --- | --- |
| Routes in the same axum app | `.api(router)`, as above | no |
| A separate server, called by the frontend at same-origin paths (`/api/...`) | `.upstream("http://127.0.0.1:4000")` | yes |
| Another origin, called by the frontend at absolute URLs (`https://api.example.com/...`) | `.allow_origin("https://api.example.com")` | yes |

The `upstream` feature adds an HTTP client (reqwest, with rustls). You need it only for the two rows that call another server:

```toml
sinter-axum = { version = "0.1", features = ["upstream"] }
```

### Resolvers: your own code for one resource

A resolver is an async Rust function you register for one resource; it produces that resource's data instead of the layer making the request. It needs no HTTP client: it usually calls the same code as your API handler, such as a database query.

You need one when the build can't describe the request. It can when the `src` is built from literals and the page's URL (`/api/articles/{$url.slug}`), paginated resources included (their first page). It can't when the `src` calls a helper (`offset($url.page, 10)`) or the resource has a `when` condition; such a resource is left to the browser unless you add a resolver.

A resolver receives a `SlotRequest` with:

- `params`: the page URL's parameters: query parameters and named path segments (`/article/:slug` gives `slug`);
- `headers`: the page request's headers;
- `url`: the URL the layer would request, if the build describes one.

It returns the JSON body the API would have returned, as `Option<Bytes>`. `None` leaves the resource to the browser.

```rust
// the API handler and the resolver share one function
async fn load_articles(page: u32) -> anyhow::Result<ArticleList> { /* query the database */ }

async fn articles(Query(q): Query<ListQuery>) -> Json<ArticleList> {
    Json(load_articles(q.page.unwrap_or(1)).await.unwrap())
}

let embed = Embed::from_dir("dist")?
    .api(api)
    .resolve("articles", |req| async move {
        let page = req.params.get("page").and_then(|p| p.parse().ok()).unwrap_or(1);
        let list = load_articles(page).await.ok()?;
        serde_json::to_vec(&list).ok().map(Into::into)
    });
```

A resolver takes precedence over the automatic request, so you can also use one to skip the HTTP round trip.

## Signed-in users

The layer fetches the data before any of the page's JavaScript runs, so the API sees only what the browser sent with its request for the page. The page uses the embedded data as is and doesn't request it again on load, so what the API returns here is what the user sees.

Which case are you in?

1. **The data is the same for everyone** (public articles, tags). Embed it; there's nothing to consider.
2. **The data is per user, and the session is a cookie.** Embed it. The browser's request for the page includes the session cookie, and the layer passes it on to `.api` and `.upstream`, so your API sees the same user. Requests to `.allow_origin` URLs get no cookies, as sinter's own requests to another origin don't either.
3. **The data is per user, and the frontend sends a token from JavaScript** (kept in `localStorage`, sent as `Authorization`). The request for the page doesn't include the token, so the API answers as if signed out. A signed-in user would see signed-out data, for example "not favorited", on every page load. Don't embed these resources: either leave their placeholder out of the page, or add a resolver that returns `None`.

Pages are sent with `Cache-Control: private, no-cache`, so a shared cache never gives one user's page to another.

## Options

| Option | Default |
| --- | --- |
| `.timeout(Duration)`: how long a page waits for all its data; anything later is left to the browser | 500 ms |
| `.forward([headers])`: the page request's headers passed on to `.api` and `.upstream` | `Cookie`, `Authorization`, `Accept-Language` |
| `.max_bytes(n)`: larger responses are left to the browser | 2 MiB |
| `.stream(false)`: send each page in one piece instead of head first | head first |
| `.cache_control(value)`: the pages' `Cache-Control` header | `private, no-cache` |

## What the layer does

- **At startup:** it reads `sinter-embed.json` and splits each page at its placeholders. `from_dir` fails if the manifest and the pages come from different builds.
- **On a GET for a page:**
  - it sends the HTML up to the first placeholder right away, so the browser loads stylesheets and scripts while the data is fetched;
  - it fetches every placeholder's data in parallel;
  - it writes the data, with `<` escaped so it can't break out of its `<script>`, then the rest of the page.
- **A placeholder it can't fill** (an error, a non-2xx or non-JSON response, one over `max_bytes`, the time limit) stays empty, and the browser requests that data.
- **What it never does:** fetch a URL whose host comes from the page's URL, or serve `sinter-embed.json` (it answers 404).

## For the frontend

To have a resource's data embedded, add an empty placeholder with its name to the page's `<head>`:

```html
<head>
  <script type="application/json" data-sn-data="articles"></script>
</head>
…
<sn-resource name="articles" src="/api/articles?tag={$url.tag}" key="slug" items="articles"></sn-resource>
```

The page also works without the layer: the placeholder stays empty and the browser requests the data. With the layer, the data is in the HTML, and the bindings over it, rows included, render while the page is parsed.

### From the source to what the browser receives

The build gives the placeholder a numeric id and lists it in `sinter-embed.json` with its request:

```html
<!-- dist/index.html -->
<script type="application/json" data-sn="0"></script>
```

```json
{ "id": 0, "resource": "articles", "src": ["/api/articles?tag=", { "url": "tag" }] }
```

For a request to `/?tag=rust`, the layer requests `/api/articles?tag=rust` from your API and writes the response body into the placeholder:

```html
<script type="application/json" data-sn="0">{"articles":[{"slug":"hello","title":"Hello"}],"articlesCount":1}</script>
```

The body goes in exactly as the API returned it (`items="articles"` picks the list out of it in the browser), except that every `<` is escaped. If the request fails, the placeholder is sent empty, as in `dist/`.

## Measured

Measured on RealWorld, slow 4G, cold Chromium; details in [docs/first-paint-comparison.md](../../docs/first-paint-comparison.md).

- **Home page LCP:** 948 → 588 ms with an API that answers at once, 1,128 → 572 ms when it takes 300 ms.
- **Throughput per core:** about 2,000 home pages/s, against 57–67 for Qwik City SSR.

The RealWorld server used for this:

```sh
cargo run --release --features upstream --example realworld -- ../../examples/realworld/dist 4370 http://localhost:4400
```
