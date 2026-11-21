//! `$url` and URL templates, as sinter's runtime computes them (`src/runtime/url.ts`), so the
//! request the server makes for a placeholder is the one the page would have made.

use percent_encoding::{AsciiSet, NON_ALPHANUMERIC, percent_decode_str, utf8_percent_encode};
use std::collections::HashMap;

use crate::manifest::Part;

/// What `encodeURIComponent` leaves as it is: letters, digits and `-_.!~*'()`.
const COMPONENT: &AsciiSet =
    &NON_ALPHANUMERIC.remove(b'-').remove(b'_').remove(b'.').remove(b'!').remove(b'~').remove(b'*').remove(b'\'').remove(b'(').remove(b')');

/// Whether a `data-sn-path` pattern (`/article/:slug`) matches the path: as many segments, and
/// the literal ones equal.
pub(crate) fn matches(pattern: &str, path: &str) -> bool {
    let want: Vec<&str> = pattern.split('/').filter(|s| !s.is_empty()).collect();
    let segs: Vec<&str> = path.split('/').filter(|s| !s.is_empty()).collect();
    want.len() == segs.len() && want.iter().zip(&segs).all(|(w, s)| w.starts_with(':') || w == s)
}

/// Whether a rule of the site's URLs is for a path: an `exact` one (a redirect) for exactly its
/// pattern, any other (a page's path, a rewrite) for a path the pattern [`matches`].
pub(crate) fn rule_for(pattern: &str, exact: bool, path: &str) -> bool {
    if exact { pattern == path } else { matches(pattern, path) }
}

/// A `$url` parameter: one value, or a list for an array parameter (bound to a `<select multiple>`
/// or a checkbox with a `value`, written as repeated keys: `?tag=a&tag=b`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Param {
    One(String),
    List(Vec<String>),
}

impl Param {
    /// the value of a parameter that is one; None for a list
    pub fn as_str(&self) -> Option<&str> {
        match self {
            Param::One(v) => Some(v),
            Param::List(_) => None,
        }
    }

    /// the values: a list's, or the one
    pub fn values(&self) -> &[String] {
        match self {
            Param::One(v) => std::slice::from_ref(v),
            Param::List(v) => v,
        }
    }
}

/// The names `$url` never takes (they could reach prototypes in the browser): dropped on read.
fn bad_key(k: &str) -> bool {
    matches!(k, "constructor" | "__proto__" | "prototype")
}

/// `$url`: the query parameters (the last of a repeated name; an array parameter, every one, an
/// empty list when absent), then the `:name` segments of the first pattern that matches the path,
/// decoded.
pub fn url_params(path: &str, query: Option<&str>, patterns: &[String], arrays: &[String]) -> HashMap<String, Param> {
    let mut out = HashMap::new();
    for k in arrays.iter().filter(|k| !bad_key(k)) {
        out.insert(k.clone(), Param::List(Vec::new()));
    }
    if let Some(q) = query {
        for (k, v) in form_urlencoded::parse(q.as_bytes()) {
            if bad_key(&k) {
                continue;
            }
            match out.get_mut(k.as_ref()) {
                Some(Param::List(l)) => l.push(v.into_owned()),
                _ => {
                    out.insert(k.into_owned(), Param::One(v.into_owned()));
                }
            }
        }
    }
    let segs: Vec<&str> = path.split('/').filter(|s| !s.is_empty()).collect();
    if let Some(p) = patterns.iter().find(|p| matches(p, path)) {
        for (w, s) in p.split('/').filter(|s| !s.is_empty()).zip(&segs) {
            if let Some(name) = w.strip_prefix(':') {
                out.insert(name.to_string(), Param::One(decode_segment(s)));
            }
        }
    }
    out
}

/// A path segment as `decodeURIComponent` decodes it, else (a `%` without two hex digits after it, or
/// escapes that are not UTF-8) as it is: the runtime's `readUrl` keeps such a segment whole.
fn decode_segment(s: &str) -> String {
    let b = s.as_bytes();
    let well_formed = b
        .iter()
        .enumerate()
        .all(|(i, &c)| c != b'%' || (b.get(i + 1).is_some_and(u8::is_ascii_hexdigit) && b.get(i + 2).is_some_and(u8::is_ascii_hexdigit)));
    if !well_formed {
        return s.to_string();
    }
    percent_decode_str(s).decode_utf8().map(|c| c.into_owned()).unwrap_or_else(|_| s.to_string())
}

/// One interpolated value, encoded: a whole `.` or `..` is encoded too, so it cannot be a dot segment.
fn encode_segment(v: &str) -> String {
    if v == "." || v == ".." {
        return v.replace('.', "%2E");
    }
    utf8_percent_encode(v, COMPONENT).to_string()
}

/// `[?&]name=` at the end of `out`: the name, else None.
fn trailing_key(out: &str) -> Option<usize> {
    let s = out.strip_suffix('=')?;
    let start = s.rfind(['?', '&'])?;
    if s[start + 1..].contains(['=', '#']) {
        return None;
    }
    Some(start + 1)
}

/// Fills a URL template from `$url`. An absent value (or an empty list) leaves its query parameter
/// out (with its `&`), or is empty elsewhere; a list that is a whole query value is a repeated key,
/// elsewhere in the query its values joined with `,` (as JavaScript writes an array); a path value
/// of `.` or `..`, or a list, is refused (None), as in the browser.
pub fn expand(parts: &[Part], params: &HashMap<String, Param>) -> Option<String> {
    let (mut out, mut query, mut dropped) = (String::new(), false, false);
    for (i, p) in parts.iter().enumerate() {
        match p {
            Part::Lit(s) => {
                // after a dropped parameter, its `&` separator goes too
                if dropped && s.starts_with('&') && (out.ends_with('?') || out.ends_with('&')) {
                    out.push_str(&s[1..])
                } else {
                    out.push_str(s)
                }
                dropped = false;
                query |= s.contains(['?', '#']);
            }
            Part::Url { url: name } => {
                let v = params.get(name);
                let whole = query
                    && match parts.get(i + 1) {
                        None => true,
                        Some(Part::Lit(n)) => n.starts_with(['&', '#']),
                        Some(_) => false,
                    };
                let key = if whole { trailing_key(&out) } else { None };
                let v = match v {
                    Some(Param::List(_)) if !query => return None,
                    Some(Param::List(l)) if l.is_empty() && key.is_some() => None,
                    Some(Param::List(l)) => match key {
                        Some(at) => {
                            let name = out[at..out.len() - 1].to_string();
                            out.push_str(&l.iter().map(|x| encode_segment(x)).collect::<Vec<_>>().join(&format!("&{name}=")));
                            continue;
                        }
                        None => Some(l.join(",")),
                    },
                    Some(Param::One(v)) => Some(v.clone()),
                    None => None,
                };
                if let Some(v) = v {
                    if !query && (v == "." || v == "..") {
                        return None;
                    }
                    out.push_str(&encode_segment(&v));
                } else if let Some(at) = key {
                    out.truncate(at);
                    dropped = true;
                }
            }
        }
    }
    // a `?` or `&` left with nothing after it (before any fragment)
    if let Some(at) =
        out.char_indices().find(|&(i, c)| (c == '?' || c == '&') && matches!(out[i + 1..].chars().next(), None | Some('#'))).map(|(i, _)| i)
    {
        out.remove(at);
    }
    Some(out)
}

/// A URL with query parameters set, as the runtime sets a paginated resource's page
/// (`withParams`): each replaces the first parameter of its name (and drops the others), or is
/// added at the end; the query is then written as a form (`URLSearchParams`).
pub fn with_params(url: &str, params: &[(String, String)]) -> String {
    if params.is_empty() {
        return url.to_string();
    }
    let (path, hash) = match url.split_once('#') {
        Some((p, h)) => (p, h.split('#').next().unwrap_or("")),
        None => (url, ""),
    };
    let (base, query) = path.split_once('?').unwrap_or((path, ""));
    let mut q: Vec<(String, String)> = form_urlencoded::parse(query.as_bytes()).into_owned().collect();
    for (k, v) in params {
        match q.iter().position(|(n, _)| n == k) {
            Some(i) => {
                q[i].1 = v.clone();
                let mut seen = 0;
                q.retain(|(n, _)| {
                    n != k || {
                        seen += 1;
                        seen == 1
                    }
                });
            }
            None => q.push((k.clone(), v.clone())),
        }
    }
    let mut out = format!("{base}?{}", form_urlencoded::Serializer::new(String::new()).extend_pairs(&q).finish());
    if !hash.is_empty() {
        out.push('#');
        out.push_str(hash);
    }
    out
}

/// A `model` (paginate) parameter as a page, as the runtime's `toPage`: the whole number `parseInt` reads at
/// the start of the value (`"3"`, `" 3x"`), else, or below 1, page 1.
pub fn to_page(v: Option<&str>) -> u64 {
    let s = v.unwrap_or("").trim_start();
    let s = s.strip_prefix('+').unwrap_or(s);
    if s.starts_with('-') {
        return 1;
    }
    let digits: String = s.chars().take_while(|c| c.is_ascii_digit()).collect();
    match digits.parse::<u64>() {
        Ok(0) => 1,
        Ok(n) => n,
        Err(_) if digits.is_empty() => 1,
        Err(_) => u64::MAX,
    }
}

// The rules themselves run on the cases src/server.ts and packages/sinter-aspnetcore run too (lib.rs, `shared_cases`);
// these are this crate's own API.
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_param_is_one_value_or_a_list() {
        let u = url_params("/", Some("tag=a&q=1&tag=b+c"), &[], &["tag".to_string()]);
        assert_eq!(u["q"].as_str(), Some("1"));
        assert_eq!(u["tag"].as_str(), None);
        assert_eq!(u["q"].values(), ["1".to_string()]);
        assert_eq!(u["tag"].values(), ["a".to_string(), "b c".to_string()]);
    }

    #[test]
    fn a_segment_decodeuricomponent_refuses_is_kept_whole() {
        // (not in the shared cases: ASP.NET Core gives sinter-aspnetcore the path already decoded, `%20` included)
        let pats = vec!["/a/:x".to_string()];
        for (path, want) in
            [("/a/a%20%zz", "a%20%zz"), ("/a/b%20%FF", "b%20%FF"), ("/a/a%2", "a%2"), ("/a/%25", "%"), ("/a/a%252Fb", "a%2Fb")]
        {
            assert_eq!(url_params(path, None, &pats, &[])["x"], Param::One(want.into()), "{path}");
        }
    }

    #[test]
    fn with_no_parameters_the_url_is_as_it_was() {
        // (no layer sets none: a placeholder without `query` is not given to withParams in src/server.ts)
        assert_eq!(with_params("/api/m?tag=a%20b", &[]), "/api/m?tag=a%20b");
    }

    #[test]
    fn a_page_past_u64_is_the_largest() {
        assert_eq!(to_page(Some("99999999999999999999999")), u64::MAX);
    }
}
