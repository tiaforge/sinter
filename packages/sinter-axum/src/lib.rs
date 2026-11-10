//! Fills a sinter build's embedded-data placeholders per request, so a static page has its API data
//! in the first frame without server rendering.
//!
//! sinter compiles pages to static HTML. A page that declares
//! `<script type="application/json" data-sn-data="articles"></script>` in its head takes that
//! JSON as the resource's data: no request from the browser, and the early script renders the
//! bindings over it, rows included, while the HTML is parsed. This crate writes that JSON: a
//! [`tower::Layer`] that answers the pages listed in the build's `sinter-embed.json`, fetches each
//! placeholder's data, and streams the page with the data in it. Everything else goes to the inner
//! service (`ServeDir`, your API).
//!
//! ```no_run
//! use axum::{Router, routing::get};
//! use sinter_axum::Embed;
//! use tower_http::services::ServeDir;
//!
//! # async fn articles() -> &'static str { "" }
//! # #[tokio::main] async fn main() -> Result<(), Box<dyn std::error::Error>> {
//! let api = Router::new().route("/api/articles", get(articles));
//! let embed = Embed::from_dir("dist")?.api(api.clone());
//! let app = Router::new()
//!     .merge(api)
//!     .fallback_service(ServeDir::new("dist"))
//!     .layer(embed);
//! # let l = tokio::net::TcpListener::bind("127.0.0.1:3000").await?;
//! # axum::serve(l, app).await?; Ok(()) }
//! ```
//!
//! Where the data comes from, per placeholder, first match:
//! 1. [`Embed::resolve`]: your function for that resource (a database query, or anything the URL
//!    template cannot express: a helper in `src`, a `when`);
//! 2. the resource's `src`, when the build could describe it (literals and `$url` reads):
//!    a same-origin path goes to [`Embed::api`] (your API router, called in-process), or else,
//!    with the `upstream` feature, to `Embed::upstream`; an absolute URL is fetched only with that
//!    feature and if its origin is allowed with `Embed::allow_origin`;
//! 3. nothing: the placeholder stays empty and the browser requests the data itself, as it does
//!    without this layer. A failure, a non-JSON or non-2xx answer, or the time limit
//!    ([`Embed::timeout`]) has the same result.
//!
//! The `upstream` feature (off by default) adds the HTTP client (`reqwest`, with rustls): without
//! it the crate fetches nothing over the network, only your router and your resolvers.

mod manifest;
mod url;

pub use manifest::{Error, Part};
pub use url::{expand, url_params, with_params};

use axum::body::Body;
use bytes::Bytes;
use futures_util::{FutureExt, StreamExt, future::BoxFuture, stream};
use http::{HeaderMap, HeaderName, HeaderValue, Method, Request, Response, StatusCode, header};
use http_body_util::{BodyExt, Limited};
use manifest::Page;
use std::{
    collections::HashMap,
    convert::Infallible,
    path::Path,
    sync::Arc,
    task::{Context, Poll},
    time::Duration,
};
use tokio::time::{Instant, timeout_at};
use tower::{Layer, Service, ServiceExt, util::BoxCloneSyncService};

/// What a resolver receives: the placeholder's resource, the request the build describes for it
/// (if any), the page's `$url` and the page request's headers.
#[derive(Clone, Debug)]
pub struct SlotRequest {
    /// the resource's name (`data-sn-data="articles"`)
    pub resource: String,
    /// the resource's `src` filled from `$url`, when the build could describe it; for a paginated
    /// resource, its first page (it may still have a `when`: see `conditional`)
    pub url: Option<String>,
    /// the resource has a `when`: only the browser evaluates it
    pub conditional: bool,
    /// the page's `$url`: query parameters, then the path's `:name` segments
    pub params: Arc<HashMap<String, String>>,
    /// the page request's headers (cookies included: the data can be the user's)
    pub headers: Arc<HeaderMap>,
}

type Resolver = Arc<dyn Fn(SlotRequest) -> BoxFuture<'static, Option<Bytes>> + Send + Sync>;
type Api = BoxCloneSyncService<Request<Body>, Response<Body>, Infallible>;

struct Inner {
    pages: Vec<Page>,
    resolvers: HashMap<String, Resolver>,
    api: Option<Api>,
    #[cfg(feature = "upstream")]
    upstream: Option<String>,
    #[cfg(feature = "upstream")]
    origins: Vec<String>,
    #[cfg(feature = "upstream")]
    http: reqwest::Client,
    forward: Vec<HeaderName>,
    timeout: Duration,
    max_bytes: usize,
    stream: bool,
    cache_control: HeaderValue,
}

/// The layer: built from a sinter build's output directory, configured with where the data comes
/// from, then added to a router with `.layer(embed)`.
#[derive(Clone)]
pub struct Embed(Arc<Inner>);

impl Embed {
    /// Reads `sinter-embed.json` and the pages it lists from a build's output directory.
    pub fn from_dir(dir: impl AsRef<Path>) -> Result<Self, Error> {
        Ok(Self(Arc::new(Inner {
            pages: manifest::load(dir.as_ref())?,
            resolvers: HashMap::new(),
            api: None,
            #[cfg(feature = "upstream")]
            upstream: None,
            #[cfg(feature = "upstream")]
            origins: Vec::new(),
            #[cfg(feature = "upstream")]
            http: reqwest::Client::new(),
            forward: vec![header::COOKIE, header::AUTHORIZATION, header::ACCEPT_LANGUAGE],
            timeout: Duration::from_millis(500),
            max_bytes: 2 << 20,
            stream: true,
            cache_control: HeaderValue::from_static("private, no-cache"),
        })))
    }

    fn with(mut self, f: impl FnOnce(&mut Inner)) -> Self {
        f(Arc::get_mut(&mut self.0).expect("configure the Embed layer before cloning it"));
        self
    }

    /// The app's own API, for same-origin `src` paths: called in-process (no socket, no HTTP
    /// parsing), with the page request's [forwarded](Embed::forward) headers.
    pub fn api<S>(self, api: S) -> Self
    where
        S: Service<Request<Body>, Response = Response<Body>, Error = Infallible> + Clone + Send + Sync + 'static,
        S::Future: Send + 'static,
    {
        self.with(|i| i.api = Some(BoxCloneSyncService::new(api)))
    }

    /// An API on another server, for same-origin `src` paths (`http://127.0.0.1:4000`): where the
    /// page's own origin proxies `/api` to. Used when no [`Embed::api`] is set.
    #[cfg(feature = "upstream")]
    pub fn upstream(self, base: impl Into<String>) -> Self {
        let b = base.into();
        self.with(|i| i.upstream = Some(b.trim_end_matches('/').to_string()))
    }

    /// An origin whose absolute `src` URLs are fetched (`https://api.example.com`), without the
    /// page's headers: the browser would not send this origin the page's cookies either.
    #[cfg(feature = "upstream")]
    pub fn allow_origin(self, origin: impl Into<String>) -> Self {
        let o = origin.into();
        self.with(|i| i.origins.push(o.trim_end_matches('/').to_string()))
    }

    /// Your function for a resource's data: the JSON text of the response the browser would get
    /// (the whole body, `items` and all), or None to leave the placeholder empty.
    pub fn resolve<F, Fut>(self, resource: impl Into<String>, f: F) -> Self
    where
        F: Fn(SlotRequest) -> Fut + Send + Sync + 'static,
        Fut: Future<Output = Option<Bytes>> + Send + 'static,
    {
        let r: Resolver = Arc::new(move |s| f(s).boxed());
        let name = resource.into();
        self.with(|i| {
            i.resolvers.insert(name, r);
        })
    }

    /// The page request's headers passed on to same-origin requests (default: `Cookie`,
    /// `Authorization`, `Accept-Language`).
    pub fn forward(self, headers: impl IntoIterator<Item = HeaderName>) -> Self {
        let h = headers.into_iter().collect();
        self.with(|i| i.forward = h)
    }

    /// How long the page waits for its data, all placeholders together (default 500 ms); one
    /// not filled by then stays empty, and the browser requests it.
    pub fn timeout(self, t: Duration) -> Self {
        self.with(|i| i.timeout = t)
    }

    /// The largest response put into a page (default 2 MiB); a larger one stays with the browser.
    pub fn max_bytes(self, n: usize) -> Self {
        self.with(|i| i.max_bytes = n)
    }

    /// Whether the page is streamed (default): the head up to the first placeholder goes out at
    /// once, so the browser loads stylesheets and scripts while the data is fetched. Without it,
    /// the page is sent whole once the data is in.
    pub fn stream(self, on: bool) -> Self {
        self.with(|i| i.stream = on)
    }

    /// The pages' `Cache-Control` (default `private, no-cache`: the data may be the user's, and
    /// it is current only when sent).
    pub fn cache_control(self, v: HeaderValue) -> Self {
        self.with(|i| i.cache_control = v)
    }

    fn page(&self, path: &str) -> Option<usize> {
        self.0.pages.iter().position(|p| p.paths.iter().any(|pat| url::matches(pat, path)))
    }
}

impl<S> Layer<S> for Embed {
    type Service = EmbedService<S>;
    fn layer(&self, inner: S) -> Self::Service {
        EmbedService { embed: self.clone(), inner }
    }
}

/// The service [`Embed`] wraps around the inner one.
#[derive(Clone)]
pub struct EmbedService<S> {
    embed: Embed,
    inner: S,
}

impl<S, B> Service<Request<B>> for EmbedService<S>
where
    S: Service<Request<B>, Response = Response<Body>> + Send + 'static,
    S::Future: Send + 'static,
    B: Send + 'static,
{
    type Response = Response<Body>;
    type Error = S::Error;
    type Future = BoxFuture<'static, Result<Response<Body>, S::Error>>;

    fn poll_ready(&mut self, cx: &mut Context<'_>) -> Poll<Result<(), S::Error>> {
        self.inner.poll_ready(cx)
    }

    fn call(&mut self, req: Request<B>) -> Self::Future {
        let read = req.method() == Method::GET || req.method() == Method::HEAD;
        // the manifest describes the app's requests; it is not a page
        if read && req.uri().path().strip_prefix('/') == Some(manifest::FILE) {
            return async { Ok(Response::builder().status(StatusCode::NOT_FOUND).body(Body::empty()).unwrap()) }.boxed();
        }
        match self.embed.page(req.uri().path()).filter(|_| read) {
            Some(i) => {
                let (embed, head) = (self.embed.clone(), req.method() == Method::HEAD);
                let (parts, _) = req.into_parts();
                async move { Ok(render(embed, i, parts, head)) }.boxed()
            }
            None => self.inner.call(req).boxed(),
        }
    }
}

fn render(embed: Embed, i: usize, req: http::request::Parts, head: bool) -> Response<Body> {
    let res = Response::builder()
        .header(header::CONTENT_TYPE, "text/html; charset=utf-8")
        .header(header::CACHE_CONTROL, embed.0.cache_control.clone());
    if head {
        return res.body(Body::empty()).unwrap();
    }
    let page = &embed.0.pages[i];
    let params = Arc::new(url_params(req.uri.path(), req.uri.query(), &page.paths));
    let headers = Arc::new(req.headers);
    let deadline = Instant::now() + embed.0.timeout;
    let fills: Vec<_> = page
        .slots
        .iter()
        .map(|s| {
            let r = SlotRequest {
                resource: s.resource.clone(),
                url: s.src.as_deref().and_then(|t| expand(t, &params)).map(|u| with_params(&u, &s.query)),
                conditional: s.when,
                params: params.clone(),
                headers: headers.clone(),
            };
            let e = embed.clone();
            async move { timeout_at(deadline, fill(&e, r)).await.ok().flatten().map(escape) }
        })
        .collect();
    let n = fills.len().max(1);
    let body = if embed.0.stream {
        let parts = page.parts.clone();
        let first = stream::once(std::future::ready(Ok::<_, Infallible>(parts[0].clone())));
        let rest = stream::iter(fills).buffered(n).zip(stream::iter(parts.into_iter().skip(1))).map(|(json, part)| {
            Ok(match json {
                Some(j) => [j, part].concat().into(),
                None => part,
            })
        });
        Body::from_stream(first.chain(rest))
    } else {
        let parts = page.parts.clone();
        Body::from_stream(stream::once(async move {
            let json = futures_util::future::join_all(fills).await;
            let mut out =
                Vec::with_capacity(parts.iter().map(Bytes::len).sum::<usize>() + json.iter().flatten().map(Bytes::len).sum::<usize>());
            for (k, p) in parts.iter().enumerate() {
                if k > 0 {
                    if let Some(j) = &json[k - 1] {
                        out.extend_from_slice(j)
                    }
                }
                out.extend_from_slice(p);
            }
            Ok::<_, Infallible>(Bytes::from(out))
        }))
    };
    res.status(StatusCode::OK).body(body).unwrap()
}

/// The data for one placeholder, or None to leave it to the browser.
async fn fill(e: &Embed, r: SlotRequest) -> Option<Bytes> {
    let i = &e.0;
    if let Some(f) = i.resolvers.get(&r.resource) {
        return f(r).await;
    }
    if r.conditional {
        return None;
    }
    let url = r.url.as_deref()?;
    // a path of this origin; `//host` is another origin
    if url.starts_with('/') && !url.starts_with("//") {
        if let Some(api) = &i.api {
            let mut q = Request::get(url).body(Body::empty()).ok()?;
            forward(&i.forward, &r.headers, q.headers_mut());
            q.headers_mut().insert(header::ACCEPT, HeaderValue::from_static("application/json"));
            let res = api.clone().oneshot(q).await.ok()?;
            if !res.status().is_success() || !is_json(res.headers()) {
                return None;
            }
            return Limited::new(res.into_body(), i.max_bytes).collect().await.ok().map(|b| b.to_bytes());
        }
        #[cfg(feature = "upstream")]
        if let Some(base) = &i.upstream {
            let mut h = HeaderMap::new();
            forward(&i.forward, &r.headers, &mut h);
            return get(i, &format!("{base}{url}"), h).await;
        }
        return None;
    }
    #[cfg(feature = "upstream")]
    if i.origins.iter().any(|o| url.strip_prefix(o.as_str()).is_some_and(|rest| rest.starts_with(['/', '?']) || rest.is_empty())) {
        return get(i, url, HeaderMap::new()).await;
    }
    None
}

#[cfg(feature = "upstream")]
async fn get(i: &Inner, url: &str, mut headers: HeaderMap) -> Option<Bytes> {
    headers.insert(header::ACCEPT, HeaderValue::from_static("application/json"));
    let mut res = i.http.get(url).headers(headers).send().await.ok()?;
    if !res.status().is_success() || !is_json(res.headers()) || res.content_length().is_some_and(|n| n as usize > i.max_bytes) {
        return None;
    }
    let mut out = Vec::new();
    while let Some(chunk) = res.chunk().await.ok()? {
        if out.len() + chunk.len() > i.max_bytes {
            return None;
        }
        out.extend_from_slice(&chunk);
    }
    Some(out.into())
}

fn forward(names: &[HeaderName], from: &HeaderMap, to: &mut HeaderMap) {
    for n in names {
        for v in from.get_all(n) {
            to.append(n.clone(), v.clone());
        }
    }
}

fn is_json(h: &HeaderMap) -> bool {
    h.get(header::CONTENT_TYPE).and_then(|v| v.to_str().ok()).is_some_and(|t| {
        let t = t.split(';').next().unwrap_or("").trim().to_ascii_lowercase();
        t == "application/json" || t.ends_with("+json")
    })
}

/// `<` as `\u003c`, so the data cannot close its `<script>` (or open a comment): the same JSON,
/// since in valid JSON `<` is only ever inside a string.
pub fn escape(json: Bytes) -> Bytes {
    if !json.contains(&b'<') {
        return json;
    }
    let mut out = Vec::with_capacity(json.len() + 32);
    for &b in json.iter() {
        if b == b'<' { out.extend_from_slice(b"\\u003c") } else { out.push(b) }
    }
    out.into()
}
