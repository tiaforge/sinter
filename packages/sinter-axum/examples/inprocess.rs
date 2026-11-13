// RealWorld's build served with its API in the same app: the layer calls the API router in-process
// (`.api(router)`), the case bench/in-process measures against the other layers. The API answers each
// route with recorded JSON (bench/in-process/data), so every layer's API does the same, trivial work.
// The build's absolute API URLs are made same-origin paths by bench/in-process/run.sh.
//
//   cargo run --release --example inprocess -- <dist> [port] <data dir>
use axum::{
    Router,
    http::{StatusCode, header},
    response::IntoResponse,
    routing::get,
    serve::ListenerExt,
};
use bytes::Bytes;
use sinter_axum::Embed;
use tower_http::compression::CompressionLayer;

fn json(body: Bytes) -> impl Fn() -> std::future::Ready<axum::response::Response> + Clone {
    move || std::future::ready(([(header::CONTENT_TYPE, "application/json")], body.clone()).into_response())
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut args = std::env::args().skip(1);
    let dir = args.next().ok_or("usage: inprocess <dist> [port] <data dir>")?;
    let port = args.next().unwrap_or_else(|| "4370".into());
    let data = args.next().ok_or("usage: inprocess <dist> [port] <data dir>")?;
    let read = |f: &str| std::fs::read(format!("{data}/{f}.json")).map(Bytes::from);
    let api = Router::new()
        .route("/api/articles", get(json(read("articles")?)))
        .route("/api/tags", get(json(read("tags")?)))
        .route("/api/articles/{slug}", get(json(read("article")?)))
        .route("/api/articles/{slug}/comments", get(json(read("comments")?)))
        .route("/api/profiles/{username}", get(json(read("profile")?)));
    let embed = Embed::from_dir(&dir).api(api.clone()).skip("profile.html:articles").build()?;
    let app = Router::new().merge(api).fallback(|| async { StatusCode::NOT_FOUND }).layer(embed).layer(CompressionLayer::new());
    let l = tokio::net::TcpListener::bind(format!("127.0.0.1:{port}")).await?.tap_io(|tcp| {
        let _ = tcp.set_nodelay(true);
    });
    println!("http://127.0.0.1:{port}");
    axum::serve(l, app).await?;
    Ok(())
}
