//! `sinter-embed.json`, which the sinter Vite plugin writes next to the built pages, and the pages
//! cut at their placeholders.

use bytes::Bytes;
use serde::Deserialize;
use std::{fmt, path::Path};

#[derive(Debug, Deserialize)]
pub(crate) struct Manifest {
    pub version: u32,
    pub pages: Vec<PageDesc>,
}

#[derive(Debug, Deserialize)]
pub(crate) struct PageDesc {
    /// the HTML file, relative to the build's output directory
    pub file: String,
    /// the paths it answers at: `data-sn-path` patterns, else where its file is served
    pub paths: Vec<String>,
    pub data: Vec<SlotDesc>,
}

/// One placeholder: `<script type="application/json" data-sn="{id}"></script>` in the page's head.
#[derive(Debug, Clone, Deserialize)]
pub(crate) struct SlotDesc {
    pub id: u32,
    pub resource: String,
    /// the resource's URL template, when only literals and `$url` reads make it up
    pub src: Option<Vec<Part>>,
    /// the resource's `when`: a condition this crate evaluates, or one only the browser can
    #[serde(default)]
    pub when: Option<When>,
    /// paginated: the first page's query parameters, set on the template's URL
    #[serde(default)]
    pub query: Vec<(String, String)>,
    /// paginated, starting at a page from `$url` (`start-page`)
    #[serde(default)]
    pub start: Option<Start>,
}

impl SlotDesc {
    /// whether the build describes the request completely: its URL, and its `when` if it has one
    pub fn described(&self) -> bool {
        self.src.is_some() && !matches!(self.when, Some(When::Browser(_)))
    }
}

/// `when`: `true` (only the browser evaluates it), or a condition over `$url`.
#[derive(Debug, Clone, Deserialize)]
#[serde(untagged)]
pub(crate) enum When {
    Browser(#[allow(dead_code)] bool),
    Cond(Cond),
}

/// A `when` over `$url` values: present and not empty, equal or not to a string, and `!`, `&&`, `||`.
#[derive(Debug, Clone, Deserialize)]
#[serde(untagged)]
pub(crate) enum Cond {
    Not { not: Box<Cond> },
    And { and: Vec<Cond> },
    Or { or: Vec<Cond> },
    Url { url: String, eq: Option<String>, ne: Option<String> },
}

impl Cond {
    /// as JavaScript evaluates it: an absent value is `undefined`, an empty string is falsy
    pub fn holds(&self, params: &std::collections::HashMap<String, String>) -> bool {
        match self {
            Cond::Not { not } => !not.holds(params),
            Cond::And { and } => and.iter().all(|c| c.holds(params)),
            Cond::Or { or } => or.iter().any(|c| c.holds(params)),
            Cond::Url { url, eq, ne } => {
                let v = params.get(url);
                match (eq, ne) {
                    (Some(e), _) => v == Some(e),
                    (_, Some(n)) => v != Some(n),
                    _ => v.is_some_and(|v| !v.is_empty()),
                }
            }
        }
    }
}

/// `start-page` from `$url`: from page 2 on, `query` with `key` set to the page (with `skip`, to
/// the items to skip, `(page - 1) * size`).
#[derive(Debug, Clone, Deserialize)]
pub(crate) struct Start {
    pub url: String,
    pub key: String,
    pub size: u64,
    #[serde(default)]
    pub skip: bool,
    pub query: Vec<(String, String)>,
}

impl Start {
    /// the first page's query parameters for this request
    pub fn params<'a>(
        &'a self,
        first: &'a [(String, String)],
        params: &std::collections::HashMap<String, String>,
    ) -> std::borrow::Cow<'a, [(String, String)]> {
        let n = crate::url::to_page(params.get(&self.url).map(String::as_str));
        if n <= 1 {
            return std::borrow::Cow::Borrowed(first);
        }
        let v = if self.skip { (n - 1).saturating_mul(self.size) } else { n };
        std::borrow::Cow::Owned(
            self.query.iter().map(|(k, x)| (k.clone(), if *k == self.key { v.to_string() } else { x.clone() })).collect(),
        )
    }
}

/// A piece of a URL template: literal text, or a `$url` value.
#[derive(Debug, Clone, Deserialize, PartialEq)]
#[serde(untagged)]
pub enum Part {
    Lit(String),
    Url { url: String },
}

/// A page cut at its placeholders: `parts[i]` comes before `slots[i]`, the last part after them all.
#[derive(Debug)]
pub(crate) struct Page {
    pub file: String,
    pub paths: Vec<String>,
    pub parts: Vec<Bytes>,
    pub slots: Vec<SlotDesc>,
}

/// A build the middleware cannot use.
#[derive(Debug)]
pub struct Error(pub(crate) String);

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "sinter-axum: {}", self.0)
    }
}
impl std::error::Error for Error {}

pub(crate) const FILE: &str = "sinter-embed.json";

pub(crate) fn parse(text: &str) -> Result<Manifest, Error> {
    let m: Manifest = serde_json::from_str(text).map_err(|e| Error(e.to_string()))?;
    if m.version != 1 {
        return Err(Error(format!("version {} (this crate reads version 1)", m.version)));
    }
    Ok(m)
}

/// Reads the manifest of a build; with `compiled`, the one the binary was compiled against (`embed!`),
/// which the build must still have.
pub(crate) fn load(dir: &Path, compiled: Option<&str>) -> Result<Vec<Page>, Error> {
    let at = dir.join(FILE);
    let text = std::fs::read_to_string(&at).map_err(|e| {
        Error(format!("{}: {e} (built with sinter's Vite plugin, with `embed: true` or a `data-sn-data` placeholder?)", at.display()))
    })?;
    let m: Manifest = parse(&text).map_err(|e| Error(format!("{}: {}", at.display(), e.0)))?;
    if let Some(c) = compiled {
        let (a, b) = (serde_json::from_str::<serde_json::Value>(&text).ok(), serde_json::from_str::<serde_json::Value>(c).ok());
        if a != b {
            return Err(Error(format!(
                "{} is not the build this binary was compiled against (embed!): build the frontend and the server from the same source",
                at.display()
            )));
        }
    }
    m.pages
        .into_iter()
        .map(|p| {
            let file = dir.join(&p.file);
            let html = std::fs::read_to_string(&file).map_err(|e| Error(format!("{}: {e}", file.display())))?;
            split(&html, p.paths, p.data)
                .map(|pg| Page { file: p.file.clone(), ..pg })
                .map_err(|e| Error(format!("{}: {}", file.display(), e.0)))
        })
        .collect()
}

/// Cuts the page at each placeholder, in document order; a placeholder that is missing or already
/// has content means the HTML and the manifest are from different builds.
pub(crate) fn split(html: &str, paths: Vec<String>, mut slots: Vec<SlotDesc>) -> Result<Page, Error> {
    let mut at: Vec<(usize, usize, SlotDesc)> = Vec::new();
    for s in slots.drain(..) {
        let open = format!(r#"<script type="application/json" data-sn="{}">"#, s.id);
        let i = html.find(&open).ok_or_else(|| {
            Error(format!(
                "no placeholder for `{}` (data-sn=\"{}\"): the page and sinter-embed.json are from different builds",
                s.resource, s.id
            ))
        })?;
        let j = i + open.len();
        if !html[j..].starts_with("</script>") {
            return Err(Error(format!("the placeholder for `{}` is not empty", s.resource)));
        }
        at.push((i, j, s));
    }
    at.sort_by_key(|x| x.0);
    let (mut parts, mut out, mut from) = (Vec::new(), Vec::new(), 0);
    for (_, j, s) in at {
        parts.push(Bytes::copy_from_slice(&html.as_bytes()[from..j]));
        from = j;
        out.push(s);
    }
    parts.push(Bytes::copy_from_slice(&html.as_bytes()[from..]));
    Ok(Page { file: String::new(), paths, parts, slots: out })
}
