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
    /// a `when` condition: only the browser can evaluate it
    #[serde(default)]
    pub when: bool,
    /// paginated: the first page's query parameters, set on the template's URL
    #[serde(default)]
    pub query: Vec<(String, String)>,
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

pub(crate) fn load(dir: &Path) -> Result<Vec<Page>, Error> {
    let at = dir.join(FILE);
    let text = std::fs::read_to_string(&at)
        .map_err(|e| Error(format!("{}: {e} (built with sinter's Vite plugin, and a page with `data-sn-data`?)", at.display())))?;
    let m: Manifest = serde_json::from_str(&text).map_err(|e| Error(format!("{}: {e}", at.display())))?;
    if m.version != 1 {
        return Err(Error(format!("{}: version {} (this crate reads version 1)", at.display(), m.version)));
    }
    m.pages
        .into_iter()
        .map(|p| {
            let file = dir.join(&p.file);
            let html = std::fs::read_to_string(&file).map_err(|e| Error(format!("{}: {e}", file.display())))?;
            split(&html, p.paths, p.data).map_err(|e| Error(format!("{}: {}", file.display(), e.0)))
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
    Ok(Page { paths, parts, slots: out })
}
