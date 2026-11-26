// RealWorld's build (examples/realworld, built with SINTER_EMBED=1) served with its data in the
// page. Every placeholder but one is described by the build, on an API origin allowed here. The
// profile's article list picks its query parameter with a ternary (`author` or `favorited`), which
// the build cannot describe: a resolver makes that request. RealWorld keeps its token in
// localStorage, so this server embeds the signed-out view (`favorited` false): it is for measuring.
//
//   cargo run --release --features upstream --example realworld -- <dist> [port] [api origin]
//
// Without the arguments, the environment: `PORT` (4370), `API` (http://localhost:4400) and `HOST` (127.0.0.1; a container
// sets 0.0.0.0: examples/realworld/Dockerfile).
use axum::{
    Router,
    http::{HeaderValue, header},
    middleware::{self, Next},
    response::Response,
};
use sinter_axum::{Embed, Param, to_page};
use std::time::Duration;
use tower_http::{compression::CompressionLayer, services::ServeDir};

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut args = std::env::args().skip(1);
    let dir = args.next().ok_or("usage: realworld <dist> [port] [api origin]")?;
    let env = |name: &str, default: &str| std::env::var(name).ok().filter(|v| !v.is_empty()).unwrap_or_else(|| default.into());
    let port = args.next().unwrap_or_else(|| env("PORT", "4370"));
    let api = args.next().unwrap_or_else(|| env("API", "http://localhost:4400"));
    let host = env("HOST", "127.0.0.1");
    let (http, base) = (reqwest::Client::new(), api.clone());
    let embed = Embed::from_dir(&dir)
        .allow_origin(api.clone())
        .timeout(Duration::from_millis(800))
        // ?author=… on the profile's own tab, ?favorited=… on its favorites
        .resolve("profile.html:articles", move |r| {
            let (http, base) = (http.clone(), base.clone());
            async move {
                let user = r.params.get("username")?.as_str()?;
                let by = if r.params.get("tab").and_then(Param::as_str) == Some("favorites") { "favorited" } else { "author" };
                let offset = (to_page(r.params.get("page").and_then(Param::as_str)) - 1) * 10;
                let mut url = reqwest::Url::parse(&format!("{base}/api/articles")).ok()?;
                url.query_pairs_mut().append_pair(by, user).append_pair("offset", &offset.to_string()).append_pair("limit", "10");
                let res = http.get(url).send().await.ok()?;
                if !res.status().is_success() {
                    return None;
                }
                res.bytes().await.ok()
            }
        })
        .build()?;
    let app =
        Router::new().fallback_service(ServeDir::new(&dir)).layer(middleware::from_fn(cache)).layer(embed).layer(CompressionLayer::new());
    let l = tokio::net::TcpListener::bind(format!("{host}:{port}")).await?;
    // the head and the rest of the page are two writes: without TCP_NODELAY, the second can wait
    // for the client's delayed ACK (about 40 ms)
    use axum::serve::ListenerExt;
    let l = l.tap_io(|tcp| {
        let _ = tcp.set_nodelay(true);
    });
    println!("http://{host}:{port}");
    axum::serve(l, app).with_graceful_shutdown(stop()).await?;
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

/// Ctrl-C, and SIGTERM where there is one: as a container's first process, the server is stopped by it (`docker stop`)
async fn stop() {
    #[cfg(unix)]
    {
        use tokio::signal::unix::{SignalKind, signal};
        if let Ok(mut term) = signal(SignalKind::terminate()) {
            tokio::select! { _ = term.recv() => {}, _ = tokio::signal::ctrl_c() => {} }
            return;
        }
    }
    let _ = tokio::signal::ctrl_c().await;
}
