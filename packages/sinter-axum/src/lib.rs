//! Fills a sinter build's embedded-data placeholders per request, so a static page has its API data
//! in the first frame without server rendering.
//!
//! A sinter build made with `sinter({ embed: true })` has an empty data placeholder in each page's
//! head for every resource whose request the page's URL decides, and lists them in
//! `sinter-embed.json`. This crate is a [`tower::Layer`] that answers those pages: it fetches each
//! placeholder's data and writes it into the page. Everything else goes to the inner service
//! (`ServeDir`, your API).
//!
//! ```no_run
//! use axum::{Router, routing::get};
//! use sinter_axum::Embed;
//! use tower_http::services::ServeDir;
//!
//! # async fn articles() -> &'static str { "" }
//! # #[tokio::main] async fn main() -> Result<(), Box<dyn std::error::Error>> {
//! let api = Router::new().route("/api/articles", get(articles));
//! let embed = Embed::from_dir("dist").api(api.clone()).build()?;
//! let app = Router::new()
//!     .merge(api)
//!     .fallback_service(ServeDir::new("dist"))
//!     .layer(embed);
//! # let l = tokio::net::TcpListener::bind("127.0.0.1:3000").await?;
//! # axum::serve(l, app).await?; Ok(()) }
//! ```
//!
//! Where the data comes from, per placeholder, first match:
//! 1. [`Embed::resolve`]: your function for that resource (a database query, or a request the
//!    build cannot describe: a helper in `src`, a `when` only the browser evaluates);
//! 2. [`Embed::skip`]: none; the browser requests it;
//! 3. the request the build describes: a same-origin path goes to [`Embed::api`] (your API router,
//!    called in-process), or else, with the `upstream` feature, to `Embed::upstream`; an absolute
//!    URL is fetched only with that feature, from an origin allowed with `Embed::allow_origin`.
//!
//! [`Embed::build`] refuses a configuration that leaves a placeholder without a source, and
//! [`embed!`] does the same check when your crate compiles.
//!
//! The `upstream` feature (off by default) adds the HTTP client (`reqwest`, with rustls): without
//! it the crate fetches nothing over the network, only your router and your resolvers.

mod manifest;
mod url;

pub use manifest::{Error, Part};
pub use url::{Param, expand, to_page, url_params, with_params};

/// Checks a build's placeholders against your resolvers when your crate compiles.
///
/// ```ignore
/// let embed = sinter_axum::embed!("../web/dist", {
///     "articles" => |req| async move { load_articles(&req).await },
///     "user" => skip,
/// });
/// let layer = embed.api(api).build()?;
/// ```
///
/// The path is relative to your crate's `Cargo.toml`. It is a compile error when a placeholder has
/// neither a request the build could describe nor an entry here, or when an entry names a
/// resource the build does not have. A name applies to every page; `"profile.html:articles"`
/// names one page's. The build's `sinter-embed.json` is compiled in: [`Embed::build`] then refuses
/// a build directory with another one. [`Embed::dir`] sets where the pages are at run time
/// (default: the path given here).
#[cfg(feature = "macros")]
pub use sinter_axum_macros::embed;

use axum::body::Body;
use bytes::Bytes;
use futures_util::{FutureExt, StreamExt, future::BoxFuture, stream};
use http::{HeaderMap, HeaderName, HeaderValue, Method, Request, Response, StatusCode, header};
use http_body_util::{BodyExt, Limited};
use manifest::{Page, SlotDesc, When};
use std::{
    collections::{HashMap, HashSet},
    convert::Infallible,
    path::PathBuf,
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
    /// the page's file in the build (`index.html`)
    pub page: String,
    /// the resource's name (`data-sn-data="articles"`)
    pub resource: String,
    /// the request the build describes, filled from `$url`: the resource's `src`, a paginated
    /// one at its first page (or the page `start-page` names); None when the build could not
    /// describe it, or its `when` does not hold for this URL
    pub url: Option<String>,
    /// the page URL's parameters: the query (an array parameter as a list), then the path's `:name` segments
    pub params: Arc<HashMap<String, Param>>,
    /// the page request's headers (cookies included: the data can be the user's)
    pub headers: Arc<HeaderMap>,
}

type Resolver = Arc<dyn Fn(SlotRequest) -> BoxFuture<'static, Option<Bytes>> + Send + Sync>;
type Api = BoxCloneSyncService<Request<Body>, Response<Body>, Infallible>;

/// The configuration: a build's output directory and where the data comes from. [`Embed::build`]
/// checks it and gives the layer.
pub struct Embed {
    dir: PathBuf,
    compiled: Option<&'static str>,
    resolvers: HashMap<String, Resolver>,
    skips: HashSet<String>,
    api: Option<Api>,
    #[cfg(feature = "upstream")]
    upstream: Option<String>,
    #[cfg(feature = "upstream")]
    origins: Vec<String>,
    forward: Vec<HeaderName>,
    timeout: Duration,
    max_bytes: usize,
    stream: bool,
    cache_control: HeaderValue,
    error_text: String,
    error_redirect: Option<String>,
}

impl Embed {
    /// A build's output directory: its `sinter-embed.json` and pages are read by [`Embed::build`].
    pub fn from_dir(dir: impl Into<PathBuf>) -> Self {
        Self {
            dir: dir.into(),
            compiled: None,
            resolvers: HashMap::new(),
            skips: HashSet::new(),
            api: None,
            #[cfg(feature = "upstream")]
            upstream: None,
            #[cfg(feature = "upstream")]
            origins: Vec::new(),
            forward: vec![header::COOKIE, header::AUTHORIZATION, header::ACCEPT_LANGUAGE],
            timeout: Duration::from_millis(500),
            max_bytes: 2 << 20,
            stream: true,
            cache_control: HeaderValue::from_static("private, no-cache"),
            error_text: "Error, please retry later.".into(),
            error_redirect: None,
        }
    }

    /// [`embed!`]: the manifest the crate was compiled against, and the build's path then.
    #[doc(hidden)]
    pub fn __compiled(dir: &str, manifest: &'static str) -> Self {
        Self { compiled: Some(manifest), ..Self::from_dir(dir) }
    }

    /// Where the build's pages are at run time, when not where they were when compiling ([`embed!`]).
    pub fn dir(mut self, dir: impl Into<PathBuf>) -> Self {
        self.dir = dir.into();
        self
    }

    /// The app's own API, for same-origin paths: called in-process (no socket, no HTTP
    /// parsing), with the page request's [forwarded](Embed::forward) headers.
    pub fn api<S>(mut self, api: S) -> Self
    where
        S: Service<Request<Body>, Response = Response<Body>, Error = Infallible> + Clone + Send + Sync + 'static,
        S::Future: Send + 'static,
    {
        self.api = Some(BoxCloneSyncService::new(api));
        self
    }

    /// An API on another server, for same-origin paths (`http://127.0.0.1:4000`): where the
    /// page's own origin proxies `/api` to. Used when no [`Embed::api`] is set.
    #[cfg(feature = "upstream")]
    pub fn upstream(mut self, base: impl Into<String>) -> Self {
        self.upstream = Some(base.into().trim_end_matches('/').to_string());
        self
    }

    /// An origin whose absolute URLs are fetched (`https://api.example.com`), without the page's
    /// headers: sinter's own requests to another origin carry no cookies either.
    #[cfg(feature = "upstream")]
    pub fn allow_origin(mut self, origin: impl Into<String>) -> Self {
        self.origins.push(origin.into().trim_end_matches('/').to_string());
        self
    }

    /// Your function for a resource's data: the JSON body the API would return (the whole body,
    /// as the browser would get it), or None to leave it to the browser. `"articles"` applies to
    /// every page; `"profile.html:articles"` to one.
    pub fn resolve<F, Fut>(mut self, resource: impl Into<String>, f: F) -> Self
    where
        F: Fn(SlotRequest) -> Fut + Send + Sync + 'static,
        Fut: Future<Output = Option<Bytes>> + Send + 'static,
    {
        self.resolvers.insert(resource.into(), Arc::new(move |s| f(s).boxed()));
        self
    }

    /// A resource the server does not fill: the browser requests it (for data only the browser
    /// can request, such as the user's with a token from JavaScript). Names as for [`Embed::resolve`].
    pub fn skip(mut self, resource: impl Into<String>) -> Self {
        self.skips.insert(resource.into());
        self
    }

    /// The page request's headers passed on to same-origin requests (default: `Cookie`,
    /// `Authorization`, `Accept-Language`).
    pub fn forward(mut self, headers: impl IntoIterator<Item = HeaderName>) -> Self {
        self.forward = headers.into_iter().collect();
        self
    }

    /// How long a page waits for its data, all placeholders together (default 500 ms).
    pub fn timeout(mut self, t: Duration) -> Self {
        self.timeout = t;
        self
    }

    /// The largest response put into a page (default 2 MiB).
    pub fn max_bytes(mut self, n: usize) -> Self {
        self.max_bytes = n;
        self
    }

    /// Whether the page is streamed (default): the head up to the first placeholder goes out at
    /// once, so the browser loads stylesheets and scripts while the data is fetched. Without it,
    /// the page is sent in one piece once the data is in.
    pub fn stream(mut self, on: bool) -> Self {
        self.stream = on;
        self
    }

    /// The pages' `Cache-Control` (default `private, no-cache`: the data may be the user's).
    pub fn cache_control(mut self, v: HeaderValue) -> Self {
        self.cache_control = v;
        self
    }

    /// The text sent instead of the rest of a page whose data could not be fetched (default
    /// "Error, please retry later.").
    pub fn error_text(mut self, text: impl Into<String>) -> Self {
        self.error_text = text.into();
        self
    }

    /// Where the browser goes when a page's data could not be fetched (`/error.html`): a page you
    /// serve with the error's status. The text is shown too, if the browser does not go.
    pub fn error_redirect(mut self, url: impl Into<String>) -> Self {
        self.error_redirect = Some(url.into());
        self
    }

    /// Reads the build and checks that every placeholder has a source: a resolver, a skip, or a
    /// request the build describes and this configuration can make (a same-origin path needs
    /// [`Embed::api`] or `Embed::upstream`, an absolute URL its origin allowed). Every problem
    /// is in the error, one line each.
    pub fn build(self) -> Result<EmbedLayer, Error> {
        let (pages, routes, locales) = manifest::load(&self.dir, self.compiled)?;
        let mut problems = Vec::new();
        let names: HashSet<String> =
            pages.iter().flat_map(|p| p.slots.iter().flat_map(|s| [s.resource.clone(), format!("{}:{}", p.file, s.resource)])).collect();
        for n in self.resolvers.keys().chain(&self.skips) {
            if !names.contains(n) {
                problems.push(format!("`{n}`: no page of the build has a placeholder for it"));
            }
        }
        for p in &pages {
            for s in &p.slots {
                let named = |m: &dyn Fn(&str) -> bool| m(&format!("{}:{}", p.file, s.resource)) || m(&s.resource);
                if named(&|k| self.resolvers.contains_key(k) || self.skips.contains(k)) {
                    continue;
                }
                if let Err(why) = self.source(s) {
                    problems.push(format!(
                        "{}: `{}`: {why}; add .resolve(\"{}\", …) or .skip(\"{}\")",
                        p.file, s.resource, s.resource, s.resource
                    ));
                }
            }
        }
        if !problems.is_empty() {
            return Err(Error(format!("{} placeholder(s) have no source:\n  {}", problems.len(), problems.join("\n  "))));
        }
        Ok(EmbedLayer(Arc::new(Inner {
            pages,
            routes,
            locales,
            resolvers: self.resolvers,
            skips: self.skips,
            api: self.api,
            #[cfg(feature = "upstream")]
            upstream: self.upstream,
            #[cfg(feature = "upstream")]
            origins: self.origins,
            #[cfg(feature = "upstream")]
            http: reqwest::Client::new(),
            forward: self.forward,
            timeout: self.timeout,
            max_bytes: self.max_bytes,
            stream: self.stream,
            cache_control: self.cache_control,
            error_text: self.error_text,
            error_redirect: self.error_redirect,
        })))
    }

    /// Whether this configuration can make the request the build describes for a placeholder.
    fn source(&self, s: &SlotDesc) -> Result<(), String> {
        if !s.described() {
            return Err(if s.src.is_none() {
                "the build could not describe its request (its `src` or `start-page` calls a helper, or reads something other than `$url`)"
                    .into()
            } else {
                "its `when` is a condition only the browser can evaluate".into()
            });
        }
        let first = match s.src.as_deref().and_then(|t| t.first()) {
            Some(manifest::Part::Lit(l)) => l.as_str(),
            _ => "",
        };
        if first.starts_with('/') && !first.starts_with("//") {
            #[cfg(feature = "upstream")]
            if self.upstream.is_some() {
                return Ok(());
            }
            return if self.api.is_some() {
                Ok(())
            } else {
                Err(format!("`{first}…` is a path of this origin, and there is no .api(router) to call"))
            };
        }
        #[cfg(feature = "upstream")]
        if self.origins.iter().any(|o| first.strip_prefix(o.as_str()).is_some_and(|rest| rest.starts_with(['/', '?']) || rest.is_empty())) {
            return Ok(());
        }
        Err(if cfg!(feature = "upstream") {
            format!("`{first}…` is on an origin not allowed with .allow_origin(…)")
        } else {
            format!("`{first}…` is on another origin (the `upstream` feature fetches those)")
        })
    }
}

struct Inner {
    pages: Vec<Page>,
    /// the build's `_redirects`, as its manifest has them
    routes: Vec<manifest::Route>,
    /// `localePrefix`: the site's languages
    locales: Option<manifest::Locales>,
    resolvers: HashMap<String, Resolver>,
    skips: HashSet<String>,
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
    error_text: String,
    error_redirect: Option<String>,
}

/// The layer [`Embed::build`] gives: add it to a router with `.layer(…)`.
#[derive(Clone)]
pub struct EmbedLayer(Arc<Inner>);

impl EmbedLayer {
    fn page(&self, path: &str) -> Option<usize> {
        self.0.pages.iter().position(|p| p.paths.iter().any(|pat| url::matches(pat, path)))
    }
    /// the rule for a path: a 301 for exactly its `from`, a rewrite for a path its pattern matches
    fn route(&self, path: &str) -> Option<&manifest::Route> {
        self.0.routes.iter().find(|r| if r.status == 200 { url::matches(&r.from, path) } else { r.from == path })
    }
}

impl<S> Layer<S> for EmbedLayer {
    type Service = EmbedService<S>;
    fn layer(&self, inner: S) -> Self::Service {
        EmbedService { embed: self.clone(), inner }
    }
}

/// The service [`EmbedLayer`] wraps around the inner one.
#[derive(Clone)]
pub struct EmbedService<S> {
    embed: EmbedLayer,
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
        // an unprefixed URL of a site with languages: to the visitor's (the `locale` cookie the pages set, else
        // Accept-Language, else the base), the page's path under its prefix (a fixed rule's target: `/about.html` goes
        // straight to `/de/about/`; a pattern's, the request's); temporary, as it differs per visitor
        if let (Some(l), Some(r)) = (self.embed.0.locales.as_ref(), self.embed.route(req.uri().path()).filter(|r| read && r.choose)) {
            let lang = choose(l, req.headers());
            let path = if r.from.contains([':', '*']) { req.uri().path() } else { r.to.as_str() };
            let rest = path.strip_prefix(l.at.as_str()).unwrap_or(path.trim_start_matches('/'));
            let to = format!("{}{lang}/{rest}{}", l.at, req.uri().query().map(|q| format!("?{q}")).unwrap_or_default());
            return async move {
                Ok(Response::builder()
                    .status(StatusCode::FOUND)
                    .header(header::LOCATION, to)
                    .header(header::VARY, "Cookie, Accept-Language")
                    .body(Body::empty())
                    .unwrap())
            }
            .boxed();
        }
        // an old file URL: a permanent redirect to the page's URL, with the query
        if let Some(r) = self.embed.route(req.uri().path()).filter(|r| read && r.status != 200) {
            let to = match req.uri().query() {
                Some(q) => format!("{}?{q}", r.to),
                None => r.to.clone(),
            };
            let status = StatusCode::from_u16(r.status).unwrap_or(StatusCode::MOVED_PERMANENTLY);
            return async move { Ok(Response::builder().status(status).header(header::LOCATION, to).body(Body::empty()).unwrap()) }.boxed();
        }
        match self.embed.page(req.uri().path()).filter(|_| read) {
            Some(i) => {
                let (embed, head) = (self.embed.clone(), req.method() == Method::HEAD);
                let (parts, _) = req.into_parts();
                async move { Ok(render(embed, i, parts, head).await) }.boxed()
            }
            None => {
                // a path a page declares, for a page without embedded data: its file, as a host's rewrite serves it
                let mut req = req;
                if let Some(file) = self.embed.route(req.uri().path()).filter(|r| read && r.status == 200).and_then(|r| r.file.clone()) {
                    let pq = match req.uri().query() {
                        Some(q) => format!("/{file}?{q}"),
                        None => format!("/{file}"),
                    };
                    if let Ok(uri) = pq.parse() {
                        *req.uri_mut() = uri;
                    }
                }
                self.inner.call(req).boxed()
            }
        }
    }
}

/// The request the build describes for a placeholder at this URL, if any and if its `when` holds.
fn described_url(s: &SlotDesc, params: &HashMap<String, Param>) -> Option<String> {
    if let Some(When::Cond(c)) = &s.when {
        if !c.holds(params) {
            return None;
        }
    }
    let url = expand(s.src.as_deref()?, params)?;
    let query = match &s.start {
        Some(start) => start.params(&s.query, params),
        None => std::borrow::Cow::Borrowed(s.query.as_slice()),
    };
    Some(with_params(&url, &query))
}

/// What became of one placeholder's data.
enum Fill {
    Data(Bytes),
    /// none from the server: a resolver's `None`, a skip, a `when` that does not hold; the browser requests it
    Browser,
    /// the request failed (502) or ran out of time (504): the page is not sent
    Failed(StatusCode),
}

/// The visitor's language among the site's: the `locale` cookie the pages record, else the first of
/// `Accept-Language` the site has (`de-AT` is `de`), else the base.
fn choose(l: &manifest::Locales, h: &HeaderMap) -> String {
    let find = |x: &str| {
        let x = x.trim().to_ascii_lowercase();
        l.list
            .iter()
            .find(|c| c.to_ascii_lowercase() == x)
            .or_else(|| l.list.iter().find(|c| c.to_ascii_lowercase() == x.split('-').next().unwrap_or("")))
            .cloned()
    };
    let cookie = h
        .get_all(header::COOKIE)
        .iter()
        .filter_map(|v| v.to_str().ok())
        .flat_map(|v| v.split(';'))
        .find_map(|c| c.trim().strip_prefix("locale=").and_then(find));
    cookie
        .or_else(|| {
            h.get(header::ACCEPT_LANGUAGE)?.to_str().ok()?.split(',').filter_map(|p| find(p.split(';').next().unwrap_or(""))).next()
        })
        .unwrap_or_else(|| l.base.clone())
}

async fn render(embed: EmbedLayer, i: usize, req: http::request::Parts, head: bool) -> Response<Body> {
    let res = Response::builder()
        .header(header::CONTENT_TYPE, "text/html; charset=utf-8")
        .header(header::CACHE_CONTROL, embed.0.cache_control.clone());
    if head {
        return res.body(Body::empty()).unwrap();
    }
    let page = &embed.0.pages[i];
    let params = Arc::new(url_params(req.uri.path(), req.uri.query(), &page.paths, &page.arrays));
    let headers = Arc::new(req.headers);
    let deadline = Instant::now() + embed.0.timeout;
    let fills: Vec<_> = page
        .slots
        .iter()
        .map(|s| {
            let r = SlotRequest {
                page: page.file.clone(),
                resource: s.resource.clone(),
                url: described_url(s, &params),
                params: params.clone(),
                headers: headers.clone(),
            };
            let e = embed.clone();
            async move {
                match timeout_at(deadline, fill(&e, r)).await {
                    Ok(Fill::Data(j)) => Fill::Data(escape(j)),
                    Ok(f) => f,
                    Err(_) => Fill::Failed(StatusCode::GATEWAY_TIMEOUT),
                }
            }
        })
        .collect();
    let n = fills.len().max(1);
    let parts = page.parts.clone();
    if embed.0.stream {
        // the head up to the first placeholder at once; the rest as the data comes in, in order. A
        // failed placeholder ends the page there: still in the head, inside that placeholder's `<script>`
        let first = stream::once(std::future::ready(Ok::<_, Infallible>(parts[0].clone())));
        let e = embed.clone();
        let rest = stream::iter(fills).buffered(n).zip(stream::iter(parts.into_iter().skip(1))).scan(false, move |ended, (fill, part)| {
            if *ended {
                return std::future::ready(None);
            }
            let chunk: Bytes = match fill {
                Fill::Data(j) => [j, part].concat().into(),
                Fill::Browser => part,
                Fill::Failed(_) => {
                    *ended = true;
                    Bytes::from(format!("</script>{}", error_tail(&e.0)))
                }
            };
            std::future::ready(Some(Ok(chunk)))
        });
        return res.status(StatusCode::OK).body(Body::from_stream(first.chain(rest))).unwrap();
    }
    // in one piece: the response waits for the data, and a failure is its status
    let fills = futures_util::future::join_all(fills).await;
    if let Some(status) = fills.iter().find_map(|f| if let Fill::Failed(s) = f { Some(*s) } else { None }) {
        let doc = format!("<!DOCTYPE html><html><head><meta charset=\"utf-8\">{}", error_tail(&embed.0));
        return res.status(status).body(Body::from(doc)).unwrap();
    }
    let mut out = Vec::with_capacity(parts.iter().map(Bytes::len).sum::<usize>() + 4096);
    for (k, p) in parts.iter().enumerate() {
        if k > 0 {
            if let Fill::Data(j) = &fills[k - 1] {
                out.extend_from_slice(j)
            }
        }
        out.extend_from_slice(p);
    }
    res.status(StatusCode::OK).body(Body::from(out)).unwrap()
}

/// The end of a page whose data failed, from inside its head: a redirect to the error page if there
/// is one (a `meta` refresh, and `location.replace` where scripts run), then a body with the text.
fn error_tail(i: &Inner) -> String {
    let html = |v: &str| v.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;").replace('"', "&quot;");
    let go = i.error_redirect.as_deref().map_or(String::new(), |u| {
        let js = serde_json::to_string(u).unwrap_or_default().replace('<', "\\u003c");
        format!("<meta http-equiv=\"refresh\" content=\"0;url={}\"><script>location.replace({js})</script>", html(u))
    });
    format!("{go}</head><body data-sn-failed><p>{}</p></body></html>", html(&i.error_text))
}

/// The data for one placeholder.
async fn fill(e: &EmbedLayer, r: SlotRequest) -> Fill {
    let i = &e.0;
    let page_key = format!("{}:{}", r.page, r.resource);
    if let Some(f) = i.resolvers.get(&page_key).or_else(|| i.resolvers.get(&r.resource)) {
        return f(r).await.map_or(Fill::Browser, Fill::Data);
    }
    if i.skips.contains(&page_key) || i.skips.contains(&r.resource) {
        return Fill::Browser;
    }
    // no request at this URL (its `when` does not hold)
    let Some(url) = r.url.as_deref() else { return Fill::Browser };
    let failed = |d: Option<Bytes>| d.map_or(Fill::Failed(StatusCode::BAD_GATEWAY), Fill::Data);
    // a path of this origin; `//host` is another origin
    if url.starts_with('/') && !url.starts_with("//") {
        if let Some(api) = &i.api {
            return failed(call(i, api, url, &r.headers).await);
        }
        #[cfg(feature = "upstream")]
        if let Some(base) = &i.upstream {
            let mut h = HeaderMap::new();
            forward(&i.forward, &r.headers, &mut h);
            return failed(get(i, &format!("{base}{url}"), h).await);
        }
        // build() refuses a configuration without a source
        return Fill::Browser;
    }
    #[cfg(feature = "upstream")]
    if i.origins.iter().any(|o| url.strip_prefix(o.as_str()).is_some_and(|rest| rest.starts_with(['/', '?']) || rest.is_empty())) {
        return failed(get(i, url, HeaderMap::new()).await);
    }
    Fill::Browser
}

/// The app's router, in-process: the body of a 2xx JSON response within `max_bytes`, else None.
async fn call(i: &Inner, api: &Api, url: &str, headers: &HeaderMap) -> Option<Bytes> {
    let mut q = Request::get(url).body(Body::empty()).ok()?;
    forward(&i.forward, headers, q.headers_mut());
    q.headers_mut().insert(header::ACCEPT, HeaderValue::from_static("application/json"));
    let res = api.clone().oneshot(q).await.ok()?;
    if !res.status().is_success() || !is_json(res.headers()) {
        return None;
    }
    Limited::new(res.into_body(), i.max_bytes).collect().await.ok().map(|b| b.to_bytes())
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

/// Every `<` as a JSON unicode escape, so the data cannot close its `<script>` (or open a
/// comment): the same JSON, since in valid JSON `<` is only ever inside a string.
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
