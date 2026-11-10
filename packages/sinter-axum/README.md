# sinter-axum

Gives a [sinter](../../README.md) page its API data in the first frame, without server rendering. It's a `tower` layer for axum.

sinter builds static HTML. A page that declares an empty placeholder in its `<head>`

```html
<script type="application/json" data-sn-data="articles"></script>
<sn-resource name="articles" src="/api/articles?tag={$url.tag}" key="slug" items="articles"></sn-resource>
```

takes the JSON in it as the resource's data. The browser makes no request, and the early script renders the bindings over the data, rows included, while the HTML is parsed. This layer writes that JSON per request. For each page in the build's `sinter-embed.json` it:

1. streams the page up to the first placeholder at once, so stylesheets and scripts load while the data is fetched;
2. fetches every placeholder's data in parallel;
3. writes the data and the rest of the page.

It has no DOM, no renderer and no JS engine. Each page is cut at its placeholders once, at startup.

```rust
use axum::{Router, routing::get};
use sinter_axum::Embed;
use tower_http::{compression::CompressionLayer, services::ServeDir};

let api = Router::new().route("/api/articles", get(articles));
let app = Router::new()
    .merge(api.clone())
    .fallback_service(ServeDir::new("dist"))
    .layer(Embed::from_dir("dist")?.api(api))
    .layer(CompressionLayer::new());
```

Requests for other paths, and non-GET requests, go to the inner service. `/sinter-embed.json` itself answers 404.

## Where the data comes from

For each placeholder, the first of these that applies:

1. **`Embed::resolve(resource, f)`.** Your async function returns the JSON of the response the browser would get, or `None`. Use it for anything the build can't describe: a helper in `src` (`offset($url.page, 10)`), a `when`, pagination, or a database query instead of an HTTP round trip. It receives `$url` (query, then path parameters), the URL the build describes (if any) and the page request's headers.
2. **The resource's `src`, when the build could describe it** (literal text and plain `$url.name` reads).
   - A path on the same origin is sent to `Embed::api(router)`, your API router called in-process with no socket. Otherwise it goes to `Embed::upstream("http://127.0.0.1:4000")`. Both receive the forwarded headers (`Cookie`, `Authorization`, `Accept-Language`; change the list with `Embed::forward`).
   - An absolute URL is fetched only if its origin was allowed with `Embed::allow_origin`, and then without the page's headers, as the browser would send it.
   - A URL whose origin comes from a `$url` value is never fetched.
3. **Nothing.** The placeholder stays empty and the browser requests the data itself, as it does without this layer.

A failure, a non-2xx or non-JSON answer, a body over `max_bytes` (2 MiB), or the time limit (`Embed::timeout`, 500 ms for all placeholders together) all leave the placeholder empty too. A slow API therefore costs the page at most the time limit, never correctness.

The data is written with `<` as `\u003c`, so it can't close its `<script>`. The pages get `Cache-Control: private, no-cache`, because the data may be the user's.

## Setup

- Build the app with sinter's Vite plugin. Every build with at least one `data-sn-data` placeholder writes `dist/sinter-embed.json`. A page and a manifest from different builds are refused at startup.
- Put the placeholders in `<head>`; the runtime ignores them anywhere else.
- Serve with `TCP_NODELAY`. The head and the rest of the page are two writes, and without it the second can wait about 40 ms for the client's delayed ACK. With `axum::serve`: `listener.tap_io(|tcp| { let _ = tcp.set_nodelay(true); })`.
- Put `CompressionLayer` outside this layer. It compresses the streamed page without holding back the head.

## Signed-in users

Data fetched without the user's credentials is the anonymous view, and embedded data is not reloaded. Two cases:

- The session is in a cookie: forward it (the default), and the API answers for the user.
- The token is somewhere the server can't see (RealWorld keeps it in `localStorage`): a page with per-user fields would show the anonymous values. Leave those resources to the browser, with a resolver that returns `None` for them.

## Measured

Measured on RealWorld, slow 4G, cold Chromium; details in [docs/first-paint-comparison.md](../../docs/first-paint-comparison.md).

- **Home LCP:** 948 → 588 ms with an API that answers at once, 1,128 → 572 ms when it takes 300 ms.
- **Throughput per core:** about 2,000 home pages/s, against 57–67 for Qwik City and about 590 for the Node middleware.

```sh
cargo run --release --example realworld -- ../../examples/realworld/dist 4370 http://localhost:4400
```
