# sinter-axum

Serve a [sinter](../../README.md) app from axum with its API data already in the page. The first frame shows the data, the browser makes no API request on load, and nothing is rendered on the server.

You add one layer. For each page, it calls your API and writes the JSON into the HTML as it's sent.

## Quick start

**1. Get the build.** The frontend's `vite build` produces a `dist/` directory. If its pages embed data, it contains `sinter-embed.json`; that file tells the layer which pages need which data. No file means no page asks for embedded data (see [For the frontend](#for-the-frontend)), and `Embed::from_dir` returns an error saying so.

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

That's all. The layer calls your router in-process for each page's data, with the visitor's cookies. Requests for anything other than a page pass through untouched. If the data can't be fetched, the page is sent without it and the browser loads the data itself, as it would without the layer.

## Where the data comes from

The build records each page's API requests, so most of the time you only say how to reach your API:

| Your API | Configure | Needs the `upstream` feature |
| --- | --- | --- |
| Routes in the same axum app | `.api(router)`, as above | no |
| Another server, same paths (`/api/...`) | `.upstream("http://127.0.0.1:4000")` | yes |
| Absolute URLs in the frontend (`https://api.example.com/...`) | `.allow_origin("https://api.example.com")` | yes |

The `upstream` feature adds an HTTP client (reqwest, with rustls). You need it only for the two rows that call another server:

```toml
sinter-axum = { version = "0.1", features = ["upstream"] }
```

### Resolvers: your own code for one resource

A resolver is an async Rust function that produces one resource's data yourself, instead of the layer making the request. It needs no HTTP client. Usually it calls the same code your API handler calls: a database query, a service function.

You need one when the build can't write down the request. It can when the URL is built only from the page's URL (`/api/articles/{$url.slug}`). It can't when the frontend's `src` calls a helper (`offset($url.page, 10)`), when the resource has a `when` condition, or when it's paginated. Without a resolver, such a resource is simply left to the browser.

A resolver receives a `SlotRequest` with:

- `params`: the page's URL parameters, query string and path segments (`/article/:slug` gives `slug`);
- `headers`: the page request's headers;
- `url`: the URL the build describes, if any.

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

A resolver for a resource always wins over the automatic request, so you can also use one to skip the HTTP round trip.

## Signed-in users

The layer fetches the data while the server sends the page, before any JavaScript has run. The API therefore sees only what came with the browser's request for the page. The page then uses the embedded data as it is and does not ask the API again on load, so whatever the API returned here is what the user sees.

Which case are you in?

1. **The data is the same for everyone** (public articles, tags). Embed it; there's nothing to consider.
2. **The data is per user, and the session is a cookie.** Embed it. The browser sends the cookie with the page request, and the layer forwards it to `.api` and `.upstream` (with `Authorization` and `Accept-Language`). Your API sees the same user it would see from the browser. `.allow_origin` URLs get no cookies, as the browser wouldn't send them to another site either.
3. **The data is per user, and the frontend sends a token from JavaScript** (kept in `localStorage`, sent as `Authorization`). The page request carries no token, so the API answers as if signed out. A signed-in user would see signed-out data, for example "not favorited", on every page load. Don't embed these resources: either leave their placeholder out of the page, or add a resolver that returns `None`.

Pages are sent with `Cache-Control: private, no-cache`, so a shared cache never gives one user's page to another.

## Options

| Option | Default |
| --- | --- |
| `.timeout(Duration)`: how long a page waits for all its data; anything later is left to the browser | 500 ms |
| `.forward([headers])`: headers passed to `.api` and `.upstream` | `Cookie`, `Authorization`, `Accept-Language` |
| `.max_bytes(n)`: larger responses are left to the browser | 2 MiB |
| `.stream(false)`: send each page whole instead of head first | streamed |
| `.cache_control(value)`: for the pages | `private, no-cache` |

## What the layer does

- **At startup:** it reads `sinter-embed.json` and cuts each page at its data slots. It refuses a manifest and pages from different builds.
- **On a GET for a page:**
  - it sends the HTML up to the first slot right away, so the browser fetches stylesheets and scripts during the wait;
  - it fetches every slot's data in parallel;
  - it writes the data, with `<` escaped so it can't break out of its `<script>`, then the rest of the page.
- **Anything it can't fill** (an error, a non-JSON or non-2xx answer, the time limit) stays empty, and the browser requests it.
- **What it never does:** fetch a URL whose host comes from the request, or serve `sinter-embed.json` itself.

## For the frontend

A resource gets embedded data from an empty placeholder in the page's `<head>`, with the same name:

```html
<head>
  <script type="application/json" data-sn-data="articles"></script>
</head>
…
<sn-resource name="articles" src="/api/articles?tag={$url.tag}" key="slug" items="articles"></sn-resource>
```

The page works the same without the server: the placeholder stays empty and the browser fetches. With the layer, the data is in the HTML, and the bindings over it, rows included, render while the page is parsed.

## Measured

Measured on RealWorld, slow 4G, cold Chromium; details in [docs/first-paint-comparison.md](../../docs/first-paint-comparison.md).

- **Home page LCP:** 948 → 588 ms with an API that answers at once, 1,128 → 572 ms when it takes 300 ms.
- **Throughput per core:** about 2,000 home pages/s, against 57–67 for Qwik City SSR.

The RealWorld server used for this:

```sh
cargo run --release --features upstream --example realworld -- ../../examples/realworld/dist 4370 http://localhost:4400
```
