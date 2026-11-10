// RealWorld's build (examples/realworld, with `data-sn-data` placeholders) served with its data in
// the page. The article page and the tags are described by the build: their API is on another
// origin, allowed here. The list's `src` calls a helper (`offset($url.page, 10)`) and has a `when`,
// so a resolver makes its request: what the browser would ask for, signed out.
//
//   cargo run --release --features upstream --example realworld -- <dist> [port] [api origin]
use axum::{
    Router,
    http::{HeaderValue, header},
    middleware::{self, Next},
    response::Response,
};
use sinter_axum::Embed;
use std::time::Duration;
use tower_http::{compression::CompressionLayer, services::ServeDir};

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut args = std::env::args().skip(1);
    let dir = args.next().ok_or("usage: realworld <dist> [port] [api origin]")?;
    let port = args.next().unwrap_or_else(|| "4370".into());
    let api = args.next().unwrap_or_else(|| "http://localhost:4400".into());
    let http = reqwest::Client::new();
    let base = api.clone();
    let embed = Embed::from_dir(&dir)?.allow_origin(api.clone()).timeout(Duration::from_millis(800)).resolve("articles", move |r| {
        let (http, base) = (http.clone(), base.clone());
        async move {
            // `when="$url.feed != 'following'"`: the user's own feed is the browser's (its token is in localStorage)
            if r.params.get("feed").is_some_and(|f| f == "following") {
                return None;
            }
            let page: u64 = r.params.get("page").and_then(|p| p.parse().ok()).unwrap_or(1).max(1);
            let mut url = reqwest::Url::parse(&format!("{base}/api/articles")).ok()?;
            url.query_pairs_mut()
                .extend_pairs(r.params.get("tag").map(|t| ("tag", t.as_str())))
                .append_pair("limit", "10")
                .append_pair("offset", &((page - 1) * 10).to_string());
            let res = http.get(url).send().await.ok()?;
            if !res.status().is_success() {
                return None;
            }
            res.bytes().await.ok()
        }
    });
    let app =
        Router::new().fallback_service(ServeDir::new(&dir)).layer(middleware::from_fn(cache)).layer(embed).layer(CompressionLayer::new());
    let l = tokio::net::TcpListener::bind(format!("127.0.0.1:{port}")).await?;
    // the head and the rest of the page are two writes: without TCP_NODELAY, the second can wait
    // for the client's delayed ACK (about 40 ms)
    use axum::serve::ListenerExt;
    let l = l.tap_io(|tcp| {
        let _ = tcp.set_nodelay(true);
    });
    println!("http://127.0.0.1:{port}");
    axum::serve(l, app).await?;
    Ok(())
}

/// hashed assets cached for good, everything else revalidated
async fn cache(req: axum::extract::Request, next: Next) -> Response {
    let immutable = req.uri().path().starts_with("/assets/");
    let mut res = next.run(req).await;
    let v = if immutable { "public, max-age=31536000, immutable" } else { "no-cache" };
    res.headers_mut().insert(header::CACHE_CONTROL, HeaderValue::from_static(v));
    res
}
