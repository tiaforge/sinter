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

The build records each page's API requests. You only say how to reach the API:

| Your API | Configure |
| --- | --- |
| Routes in the same axum app | `.api(router)`, as above |
| Another server, same paths (`/api/...`) | `.upstream("http://127.0.0.1:4000")`, with the `upstream` feature |
| Absolute URLs in the frontend (`https://api.example.com/...`) | `.allow_origin("https://api.example.com")`, with the `upstream` feature |
| A request the build can't describe, or data you'd rather get straight from the database | `.resolve("articles", \|req\| async { ... })` |

The `upstream` feature adds an HTTP client (reqwest, with rustls):

```toml
sinter-axum = { version = "0.1", features = ["upstream"] }
```

**When you need `resolve`.** The build can describe a request whose URL uses only the page's URL (`/api/articles/{$url.slug}`). It can't describe one that calls a helper (`offset($url.page, 10)`), has a `when`, or is paginated. Without a resolver, those are left to the browser. A resolver gets the page's URL parameters (`req.params`), the request headers (`req.headers`) and the URL the build describes, if any. It returns the JSON body the browser would have received, or `None`:

```rust
Embed::from_dir("dist")?
    .api(api)
    .resolve("articles", |req| async move {
        let page: u32 = req.params.get("page").and_then(|p| p.parse().ok()).unwrap_or(1);
        let rows = db::articles(page).await.ok()?;
        serde_json::to_vec(&rows).ok().map(Into::into)
    })
```

## Signed-in users

Cookies and `Authorization` are forwarded to `.api` and `.upstream`, so a cookie session works: the API answers for the user. Absolute URLs get no cookies, as the browser wouldn't send them either.

If the frontend keeps its token where the server can't see it (in `localStorage`), the layer would embed the signed-out view, and the page wouldn't reload it. For resources with per-user fields, return `None` from a resolver to leave them to the browser.

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
