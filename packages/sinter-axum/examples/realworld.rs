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
    extract::State,
    http::{HeaderValue, Uri, header},
    middleware::{self, Next},
    response::Response,
};
use sinter_axum::{Embed, Param, PlaceholderRequest, to_page};
use std::{path::PathBuf, sync::Arc, time::Duration};
use tower_http::{compression::CompressionLayer, services::ServeDir};

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut args = std::env::args().skip(1);
    let dir = args.next().ok_or("usage: realworld <dist> [port] [api origin]")?;
    let env = |name: &str, default: &str| std::env::var(name).ok().filter(|v| !v.is_empty()).unwrap_or_else(|| default.into());
    let port = args.next().unwrap_or_else(|| env("PORT", "4370"));
    let api = args.next().unwrap_or_else(|| env("API", "http://localhost:4400"));
    let host = env("HOST", "127.0.0.1");
    // shorter than the page's time limit: a slow API is "no data" (the browser asks for it), not a failed page
    let http = reqwest::Client::builder().timeout(Duration::from_millis(700)).build()?;
    let quiet = |segments: &'static [&'static str], param: &'static str, after: &'static [&'static str]| {
        let (http, base) = (http.clone(), api.clone());
        move |r: PlaceholderRequest| {
            let (http, base) = (http.clone(), base.clone());
            async move {
                let mut url = reqwest::Url::parse(&format!("{base}/api")).ok()?;
                {
                    let mut path = url.path_segments_mut().ok()?;
                    for seg in segments {
                        path.push(seg);
                    }
                    path.push(r.params.get(param)?.as_str()?);
                    for seg in after {
                        path.push(seg);
                    }
                }
                get(&http, url).await
            }
        }
    };
    let (articles_http, base) = (http.clone(), api.clone());
    let embed = Embed::from_dir(&dir)
        .allow_origin(api.clone())
        .timeout(Duration::from_millis(800))
        // The API shows an anonymous visitor the demo accounts' content only: the profile, articles and comments of any other
        // account answer 404, and the browser, which has the token, asks again. A page whose data cannot be fetched is not
        // sent (`Error, please retry later.`), so these resources give "no data" instead of the error.
        .resolve("profile.html:profile", quiet(&["profiles"], "username", &[]))
        .resolve("article.html:article", quiet(&["articles"], "slug", &[]))
        .resolve("article.html:comments", quiet(&["articles"], "slug", &["comments"]))
        .resolve("editor.html:article", quiet(&["articles"], "slug", &[]))
        // ?author=… on the profile's own tab, ?favorited=… on its favorites
        .resolve("profile.html:articles", move |r| {
            let (http, base) = (articles_http.clone(), base.clone());
            async move {
                let user = r.params.get("username")?.as_str()?;
                let by = if r.params.get("tab").and_then(Param::as_str) == Some("favorites") { "favorited" } else { "author" };
                let offset = (to_page(r.params.get("page").and_then(Param::as_str)) - 1) * 10;
                let mut url = reqwest::Url::parse(&format!("{base}/api/articles")).ok()?;
                url.query_pairs_mut().append_pair(by, user).append_pair("offset", &offset.to_string()).append_pair("limit", "10");
                get(&http, url).await
            }
        })
        .build()?;
    let app = Router::new()
        .fallback_service(ServeDir::new(&dir))
        .layer(middleware::from_fn(cache))
        .layer(middleware::from_fn_with_state(Arc::new(PathBuf::from(&dir)), pretty))
        .layer(embed)
        .layer(CompressionLayer::new());
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

/// The answer of a GET, or nothing: an error, a non-2xx or a slow API is no data, not a failed page.
async fn get(http: &reqwest::Client, url: reqwest::Url) -> Option<bytes::Bytes> {
    let res = http.get(url).send().await.ok()?;
    if !res.status().is_success() {
        return None;
    }
    res.bytes().await.ok()
}

/// `/login` is `login.html`: a page with no data in it (login, register, settings) is not the layer's, and files are
/// served by their names. A static host does this itself (Cloudflare Pages)
async fn pretty(State(dir): State<Arc<PathBuf>>, mut req: axum::extract::Request, next: Next) -> Response {
    let name = req.uri().path().trim_matches('/').to_owned();
    if !name.is_empty() && !name.contains(['/', '.']) && dir.join(format!("{name}.html")).is_file() {
        let query = req.uri().query().map(|q| format!("?{q}")).unwrap_or_default();
        if let Ok(uri) = Uri::try_from(format!("/{name}.html{query}")) {
            *req.uri_mut() = uri;
        }
    }
    next.run(req).await
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
