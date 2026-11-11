// The layer over a small build: pages and sinter-embed.json written to a temporary directory.
use axum::{
    Router,
    body::Body,
    http::{HeaderMap, Request, StatusCode, header},
    response::IntoResponse,
    routing::get,
};
use bytes::Bytes;
use http_body_util::BodyExt;
use sinter_axum::{Embed, EmbedLayer};
use std::{
    path::PathBuf,
    sync::atomic::{AtomicUsize, Ordering},
    time::{Duration, Instant},
};
use tower::ServiceExt;

const HEAD: &str = r#"<!DOCTYPE html><html><head><link rel="stylesheet" href="/assets/app.css">"#;

fn build(name: &str, manifest: &str, pages: &[(&str, &str)]) -> PathBuf {
    static N: AtomicUsize = AtomicUsize::new(0);
    let dir = std::env::temp_dir().join(format!("sinter-axum-{}-{name}-{}", std::process::id(), N.fetch_add(1, Ordering::Relaxed)));
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join("sinter-embed.json"), manifest).unwrap();
    for (f, html) in pages {
        std::fs::write(dir.join(f), html).unwrap();
    }
    dir
}

/// RealWorld's shape: a list and its tags on `/` and `/tag/:tag`, an article and its comments.
fn app_build() -> PathBuf {
    build(
        "app",
        r#"{ "version": 1, "pages": [
      { "file": "index.html", "paths": ["/", "/index.html"], "data": [
        { "id": 3, "resource": "articles", "src": ["/api/articles?tag=", { "url": "tag" }, "&limit=10"] },
        { "id": 4, "resource": "tags", "src": ["/api/tags"] },
        { "id": 5, "resource": "feed", "src": ["/api/feed"], "when": true } ] },
      { "file": "article.html", "paths": ["/article/:slug"], "data": [
        { "id": 0, "resource": "article", "src": ["/api/articles/", { "url": "slug" }] },
        { "id": 1, "resource": "comments", "src": ["/api/articles/", { "url": "slug" }, "/comments"] } ] } ] }"#,
        &[
            (
                "index.html",
                &format!(
                    r#"{HEAD}<script type="application/json" data-sn="3"></script><script type="application/json" data-sn="4"></script><script type="application/json" data-sn="5"></script></head><body><main></main></body></html>"#
                ),
            ),
            (
                "article.html",
                &format!(
                    r#"{HEAD}<script type="application/json" data-sn="0"></script><script type="application/json" data-sn="1"></script></head><body></body></html>"#
                ),
            ),
        ],
    )
}

fn json(v: String) -> impl IntoResponse {
    ([(header::CONTENT_TYPE, "application/json")], v)
}

fn api() -> Router {
    Router::new()
        .route(
            "/api/articles",
            get(|q: axum::extract::RawQuery, h: HeaderMap| async move {
                let who = h.get(header::COOKIE).and_then(|v| v.to_str().ok()).unwrap_or("-").to_string();
                json(format!(r#"{{"articles":[{{"title":"</script><b>x"}}],"q":"{}","who":"{who}"}}"#, q.0.unwrap_or_default()))
            }),
        )
        .route("/api/tags", get(|| async { json(r#"{"tags":["a"]}"#.into()) }))
        .route(
            "/api/articles/{slug}",
            get(|p: axum::extract::Path<String>| async move { json(format!(r#"{{"article":{{"slug":"{}"}}}}"#, p.0)) }),
        )
        .route("/api/articles/{slug}/comments", get(|| async { (StatusCode::INTERNAL_SERVER_ERROR, "no") }))
}

/// the app: the layer over the API and a stand-in for ServeDir
fn app(layer: EmbedLayer) -> Router {
    Router::new().merge(api()).fallback(|| async { "static file" }).layer(layer)
}

async fn text(app: Router, req: Request<Body>) -> (StatusCode, HeaderMap, String) {
    let res = app.oneshot(req).await.unwrap();
    let (p, b) = res.into_parts();
    (p.status, p.headers, String::from_utf8(b.collect().await.unwrap().to_bytes().to_vec()).unwrap())
}

fn get_(uri: &str) -> Request<Body> {
    Request::get(uri).body(Body::empty()).unwrap()
}

#[tokio::test]
async fn fills_each_placeholder_from_the_api_in_process() {
    let a = app(Embed::from_dir(app_build()).api(api()).skip("feed").build().unwrap());
    let req = Request::get("/?tag=rust%20lang&x=1").header(header::COOKIE, "s=1").body(Body::empty()).unwrap();
    let (status, h, html) = text(a.clone(), req).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(h[header::CONTENT_TYPE], "text/html; charset=utf-8");
    assert_eq!(h[header::CACHE_CONTROL], "private, no-cache");
    // `$url.tag` into the template, encoded as the browser would; the cookie forwarded; `<` escaped
    assert!(html.contains(r#"<script type="application/json" data-sn="3">{"articles":[{"title":"\u003c/script>\u003cb>x"}],"q":"tag=rust%20lang&limit=10","who":"s=1"}</script>"#), "{html}");
    assert!(html.contains(r#"<script type="application/json" data-sn="4">{"tags":["a"]}</script>"#));
    // a `when`: left to the browser
    assert!(html.contains(r#"<script type="application/json" data-sn="5"></script>"#));
    assert!(html.starts_with(HEAD) && html.ends_with("<main></main></body></html>"));
    // no tag: the parameter is left out
    let (_, _, html) = text(a.clone(), get_("/")).await;
    assert!(html.contains(r#""q":"limit=10""#));
    // path parameters; a failing request (the comments answer 500) ends the page with the error text
    let (status, _, html) = text(a, get_("/article/hello%20world")).await;
    assert_eq!(status, StatusCode::OK);
    assert!(html.contains(r#"data-sn="0">{"article":{"slug":"hello world"}}</script>"#), "{html}");
    assert!(
        html.ends_with(
            r#"<script type="application/json" data-sn="1"></script></head><body data-sn-failed><p>Error, please retry later.</p></body></html>"#
        ),
        "{html}"
    );
}

#[tokio::test]
async fn other_requests_go_to_the_inner_service() {
    let a = app(Embed::from_dir(app_build()).api(api()).skip("feed").build().unwrap());
    assert_eq!(text(a.clone(), get_("/assets/app.css")).await.2, "static file");
    assert_eq!(text(a.clone(), get_("/article/a/b")).await.2, "static file");
    assert_eq!(text(a.clone(), Request::post("/").body(Body::empty()).unwrap()).await.2, "static file");
    // the manifest is not served
    assert_eq!(text(a.clone(), get_("/sinter-embed.json")).await.0, StatusCode::NOT_FOUND);
    // HEAD: the page's headers, no body, no requests
    let (s, h, body) = text(a, Request::head("/").body(Body::empty()).unwrap()).await;
    assert_eq!((s, body.as_str()), (StatusCode::OK, ""));
    assert_eq!(h[header::CONTENT_TYPE], "text/html; charset=utf-8");
}

#[tokio::test]
async fn a_resolver_takes_precedence_and_gets_what_the_template_cannot_express() {
    let embed = Embed::from_dir(app_build())
        .api(api())
        .resolve("feed", |r| async move {
            assert_eq!(r.page, "index.html");
            assert_eq!(r.url.as_deref(), Some("/api/feed"));
            let user = r.headers.get(header::COOKIE)?.to_str().ok()?.to_string();
            Some(Bytes::from(format!(r#"{{"feed":"{user}","page":"{}"}}"#, r.params.get("page").map_or("1", |s| s))))
        })
        .resolve("tags", |_| async { Some(Bytes::from_static(br#"{"tags":["mine"]}"#)) })
        .build()
        .unwrap();
    let req = Request::get("/?page=2").header(header::COOKIE, "u=7").body(Body::empty()).unwrap();
    let (_, _, html) = text(app(embed.clone()), req).await;
    assert!(html.contains(r#"data-sn="5">{"feed":"u=7","page":"2"}</script>"#), "{html}");
    assert!(html.contains(r#"data-sn="4">{"tags":["mine"]}</script>"#));
    // signed out: the resolver leaves it to the browser
    let (_, _, html) = text(app(embed), get_("/")).await;
    assert!(html.contains(r#"<script type="application/json" data-sn="5"></script>"#));
}

#[tokio::test]
async fn the_head_is_sent_before_the_data_and_slow_data_ends_the_page_at_the_time_limit() {
    let (tx, rx) = tokio::sync::oneshot::channel::<()>();
    let rx = std::sync::Mutex::new(Some(rx));
    let embed = Embed::from_dir(app_build())
        .api(api())
        .skip("feed")
        .timeout(Duration::from_millis(300))
        .resolve("article", move |_| {
            let rx = rx.lock().unwrap().take();
            async move {
                rx?.await.ok()?;
                Some(Bytes::from_static(b"{}"))
            }
        })
        .resolve("comments", |_| async {
            tokio::time::sleep(Duration::from_secs(5)).await;
            Some(Bytes::from_static(b"[]"))
        })
        .build()
        .unwrap();
    let t = Instant::now();
    let res = app(embed).oneshot(get_("/article/x")).await.unwrap();
    let mut body = res.into_body();
    // the first frame: everything before the first placeholder, while its data is still pending
    let first = body.frame().await.unwrap().unwrap().into_data().unwrap();
    assert_eq!(first, Bytes::from(format!(r#"{HEAD}<script type="application/json" data-sn="0">"#)));
    assert!(t.elapsed() < Duration::from_millis(100));
    tx.send(()).unwrap();
    let rest = String::from_utf8(body.collect().await.unwrap().to_bytes().to_vec()).unwrap();
    assert_eq!(
        rest,
        r#"{}</script><script type="application/json" data-sn="1"></script></head><body data-sn-failed><p>Error, please retry later.</p></body></html>"#
    );
    // the slow one waited for the time limit, not for itself
    let took = t.elapsed();
    assert!(took >= Duration::from_millis(300) && took < Duration::from_secs(2), "{took:?}");
}

#[tokio::test]
async fn a_paginated_resource_is_requested_at_its_first_page() {
    // the build: `paginate="offset" page-size="10" size-param="limit"` over a tag from the path
    let dir = build(
        "paginated",
        r#"{ "version": 1, "pages": [ { "file": "index.html", "paths": ["/tag/:tag"], "data": [
          { "id": 0, "resource": "articles", "src": ["/api/articles?tag=", { "url": "tag" }], "query": [["page", "1"], ["limit", "10"]] } ] } ] }"#,
        &[("index.html", r#"<head><script type="application/json" data-sn="0"></script></head>"#)],
    );
    let (_, _, html) = text(app(Embed::from_dir(dir).api(api()).build().unwrap()), get_("/tag/a%20b")).await;
    // the page's `$url` in the template, then the pager's first-page parameters, as the runtime writes them
    assert!(html.contains(r#""q":"tag=a+b&page=1&limit=10""#), "{html}");
}

#[tokio::test]
async fn unstreamed_the_page_is_one_piece_and_a_failure_is_its_status() {
    let embed = Embed::from_dir(app_build()).api(api()).skip("feed").stream(false).build().unwrap();
    let res = app(embed.clone()).oneshot(get_("/")).await.unwrap();
    assert_eq!(res.status(), StatusCode::OK);
    let mut body = res.into_body();
    let all = body.frame().await.unwrap().unwrap().into_data().unwrap();
    assert!(std::str::from_utf8(&all).unwrap().ends_with("<main></main></body></html>"));
    assert!(body.frame().await.is_none());
    // the comments answer 500: a 502 with the error text instead of the page
    let (status, _, html) = text(app(embed), get_("/article/x")).await;
    assert_eq!(status, StatusCode::BAD_GATEWAY);
    assert_eq!(
        html,
        r#"<!DOCTYPE html><html><head><meta charset="utf-8"></head><body data-sn-failed><p>Error, please retry later.</p></body></html>"#
    );
    // out of time: 504
    let slow = Embed::from_dir(app_build())
        .api(api())
        .skip("feed")
        .stream(false)
        .timeout(Duration::from_millis(50))
        .resolve("tags", |_| async {
            tokio::time::sleep(Duration::from_secs(5)).await;
            None
        })
        .build()
        .unwrap();
    assert_eq!(text(app(slow), get_("/")).await.0, StatusCode::GATEWAY_TIMEOUT);
}

#[tokio::test]
async fn a_failure_redirects_to_the_error_page_when_there_is_one() {
    let embed = Embed::from_dir(app_build())
        .api(api())
        .skip("feed")
        .error_redirect("/error?from=\"x\"<")
        .error_text("Try again <soon>")
        .build()
        .unwrap();
    let (_, _, html) = text(app(embed), get_("/article/x")).await;
    let tail = html.split(r#"data-sn="1">"#).nth(1).unwrap();
    assert_eq!(
        tail,
        r#"</script><meta http-equiv="refresh" content="0;url=/error?from=&quot;x&quot;&lt;"><script>location.replace("/error?from=\"x\"\u003c")</script></head><body data-sn-failed><p>Try again &lt;soon&gt;</p></body></html>"#
    );
}

#[tokio::test]
async fn data_left_to_the_browser_is_no_failure() {
    // a resolver's None, a skip, a `when` that does not hold: the page is sent whole, those placeholders empty
    let embed = Embed::from_dir(app_build()).api(api()).skip("feed").resolve("comments", |_| async { None }).build().unwrap();
    let (_, _, html) = text(app(embed), get_("/article/x")).await;
    assert!(html.ends_with(r#"<script type="application/json" data-sn="1"></script></head><body></body></html>"#), "{html}");
}

#[cfg(feature = "upstream")]
#[tokio::test]
async fn upstream_over_http_and_allowed_origins_only() {
    let l = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", l.local_addr().unwrap());
    tokio::spawn(async move { axum::serve(l, api()).await.unwrap() });
    let dir = build(
        "upstream",
        &format!(
            r#"{{ "version": 1, "pages": [ {{ "file": "index.html", "paths": ["/"], "data": [
        {{ "id": 0, "resource": "a", "src": ["/api/articles?tag=", {{ "url": "tag" }}] }},
        {{ "id": 1, "resource": "b", "src": ["{base}/api/tags"] }},
        {{ "id": 2, "resource": "c", "src": ["{base}/api/articles"] }},
        {{ "id": 3, "resource": "d", "src": ["http://elsewhere.invalid/api/tags"] }},
        {{ "id": 4, "resource": "e", "src": [{{ "url": "next" }}] }} ] }} ] }}"#
        ),
        &[(
            "index.html",
            r#"<head><script type="application/json" data-sn="0"></script><script type="application/json" data-sn="1"></script><script type="application/json" data-sn="2"></script><script type="application/json" data-sn="3"></script><script type="application/json" data-sn="4"></script></head>"#,
        )],
    );
    // another origin, or a URL whose origin a value makes up: refused when building
    let err = Embed::from_dir(&dir).upstream(base.clone()).allow_origin(base.clone()).build().err().unwrap().to_string();
    assert!(err.contains("2 placeholder(s) have no source"), "{err}");
    assert!(
        err.contains("index.html: `d`: `http://elsewhere.invalid/api/tags…` is on an origin not allowed with .allow_origin(…)"),
        "{err}"
    );
    assert!(err.contains("index.html: `e`:"), "{err}");
    let embed = Embed::from_dir(dir).upstream(base.clone()).allow_origin(base.clone()).skip("d").skip("e").build().unwrap();
    let req =
        Request::get(format!("/?tag=t&next={}", "http%3A%2F%2Fevil.invalid%2F")).header(header::COOKIE, "s=1").body(Body::empty()).unwrap();
    let (_, _, html) = text(app(embed), req).await;
    // same origin, through the upstream, with the cookie
    assert!(html.contains(r#""q":"tag=t","who":"s=1""#), "{html}");
    // an allowed origin: fetched, without the page's cookie
    assert!(html.contains(r#"data-sn="1">{"tags":["a"]}</script>"#));
    assert!(html.contains(r#"data-sn="2">{"articles":[{"title":"\u003c/script>\u003cb>x"}],"q":"","who":"-"}</script>"#), "{html}");
    // skipped: left to the browser
    assert!(html.contains(r#"<script type="application/json" data-sn="3"></script>"#));
    assert!(html.contains(r#"<script type="application/json" data-sn="4"></script>"#));
}

#[test]
fn a_page_from_another_build_is_refused() {
    let dir = build(
        "stale",
        r#"{ "version": 1, "pages": [ { "file": "index.html", "paths": ["/"], "data": [ { "id": 9, "resource": "a", "src": null } ] } ] }"#,
        &[("index.html", r#"<head><script type="application/json" data-sn="1"></script></head>"#)],
    );
    let err = Embed::from_dir(&dir).skip("a").build().err().unwrap().to_string();
    assert!(err.contains("no placeholder for `a`"), "{err}");
    let dir = build(
        "filled",
        r#"{ "version": 1, "pages": [ { "file": "index.html", "paths": ["/"], "data": [ { "id": 1, "resource": "a", "src": null } ] } ] }"#,
        &[("index.html", r#"<head><script type="application/json" data-sn="1">{}</script></head>"#)],
    );
    assert!(Embed::from_dir(&dir).skip("a").build().err().unwrap().to_string().contains("not empty"));
    assert!(
        Embed::from_dir(std::env::temp_dir().join("sinter-axum-none")).build().err().unwrap().to_string().contains("sinter-embed.json")
    );
}

#[test]
fn build_refuses_placeholders_without_a_source_and_names_that_are_not_placeholders() {
    // `feed` has a `when` only the browser evaluates; no .api(router) for the paths
    let err = Embed::from_dir(app_build()).resolve("artcles", |_| async { None }).build().err().unwrap().to_string();
    for want in [
        "`artcles`: no page of the build has a placeholder for it",
        "index.html: `feed`: its `when` is a condition only the browser can evaluate; add .resolve(\"feed\", …) or .skip(\"feed\")",
        "index.html: `tags`: `/api/tags…` is a path of this origin, and there is no .api(router) to call",
        "article.html: `article`:",
    ] {
        assert!(err.contains(want), "{want}\n{err}");
    }
    // a page-qualified name covers that page's placeholder
    assert!(Embed::from_dir(app_build()).api(api()).skip("index.html:feed").build().is_ok());
    assert!(Embed::from_dir(app_build()).api(api()).skip("article.html:feed").build().is_err());
}

#[tokio::test]
async fn when_and_start_page_are_evaluated_from_the_url() {
    let dir = build(
        "when",
        r#"{ "version": 1, "pages": [ { "file": "index.html", "paths": ["/"], "data": [
          { "id": 0, "resource": "articles", "src": ["/api/articles?tag=", { "url": "tag" }], "when": { "url": "feed", "ne": "following" },
            "query": [["offset", "0"], ["limit", "10"]],
            "start": { "url": "page", "key": "offset", "size": 10, "skip": true, "query": [["offset", "10"], ["limit", "10"]] } } ] } ] }"#,
        &[("index.html", r#"<head><script type="application/json" data-sn="0"></script></head>"#)],
    );
    let a = app(Embed::from_dir(dir).api(api()).build().unwrap());
    let q = |html: String| html.split(r#""q":""#).nth(1).map(|r| r.split('"').next().unwrap().to_string());
    assert_eq!(q(text(a.clone(), get_("/?tag=x")).await.2).as_deref(), Some("tag=x&offset=0&limit=10"));
    assert_eq!(q(text(a.clone(), get_("/?page=3")).await.2).as_deref(), Some("offset=20&limit=10"));
    assert_eq!(q(text(a.clone(), get_("/?page=abc")).await.2).as_deref(), Some("offset=0&limit=10"));
    // `when` does not hold: no request, the placeholder empty
    let (_, _, html) = text(a, get_("/?feed=following")).await;
    assert!(html.contains(r#"<script type="application/json" data-sn="0"></script>"#), "{html}");
}

/// The build's `_redirects`, from its manifest: 301s from old file URLs (with the query), and a path a
/// page declares rewritten to its file when the page has no embedded data (the page with data answers itself).
#[tokio::test]
async fn follows_the_sites_rules_301s_and_rewrites() {
    let dir = build(
        "routes",
        r#"{ "version": 1, "pages": [
      { "file": "article.html", "paths": ["/article/:slug"], "data": [
        { "id": 0, "resource": "article", "src": ["/api/articles/", { "url": "slug" }] } ] } ],
      "routes": [
        { "from": "/about.html", "to": "/about/", "status": 301 },
        { "from": "/support", "to": "/help", "status": 200, "file": "help.html" },
        { "from": "/article/:slug", "to": "/article", "status": 200, "file": "article.html" } ] }"#,
        &[("article.html", &format!(r#"{HEAD}<script type="application/json" data-sn="0"></script></head><body></body></html>"#))],
    );
    // the inner service echoes the path it is asked for, as ServeDir would serve that file
    let a = Router::new()
        .merge(api())
        .fallback(|uri: axum::http::Uri| async move { format!("file {}", uri) })
        .layer(Embed::from_dir(dir).api(api()).build().unwrap());
    let (s, h, _) = text(a.clone(), get_("/about.html?x=1")).await;
    assert_eq!(s, StatusCode::MOVED_PERMANENTLY);
    assert_eq!(h[header::LOCATION], "/about/?x=1");
    assert_eq!(text(a.clone(), get_("/support?q=2")).await.2, "file /help.html?q=2");
    // a page with data: answered by the layer, data embedded
    let (s, _, html) = text(a.clone(), get_("/article/hello")).await;
    assert_eq!(s, StatusCode::OK);
    assert!(html.contains(r#"{"article":{"slug":"hello"}}"#), "{html}");
    // anything else: as it was
    assert_eq!(text(a, get_("/about/")).await.2, "file /about/");
}
