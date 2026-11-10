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

/// `$url`: the query parameters (the last of a repeated name), then the `:name` segments of the
/// first pattern that matches the path, decoded.
pub fn url_params(path: &str, query: Option<&str>, patterns: &[String]) -> HashMap<String, String> {
    let mut out = HashMap::new();
    if let Some(q) = query {
        for (k, v) in form_urlencoded::parse(q.as_bytes()) {
            out.insert(k.into_owned(), v.into_owned());
        }
    }
    let segs: Vec<&str> = path.split('/').filter(|s| !s.is_empty()).collect();
    if let Some(p) = patterns.iter().find(|p| matches(p, path)) {
        for (w, s) in p.split('/').filter(|s| !s.is_empty()).zip(&segs) {
            if let Some(name) = w.strip_prefix(':') {
                let v = percent_decode_str(s).decode_utf8().map(|c| c.into_owned()).unwrap_or_else(|_| s.to_string());
                out.insert(name.to_string(), v);
            }
        }
    }
    out
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

/// Fills a URL template from `$url`. An absent value leaves its query parameter out (with its `&`),
/// or is empty elsewhere; a path value of `.` or `..` is refused (None), as in the browser.
pub fn expand(parts: &[Part], params: &HashMap<String, String>) -> Option<String> {
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
                if let Some(v) = v {
                    if !query && (v == "." || v == "..") {
                        return None;
                    }
                    out.push_str(&encode_segment(v));
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

/// What `start-page` gives as a page, as the runtime's `toPage`: the whole number `parseInt` reads at
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

#[cfg(test)]
mod tests {
    use super::*;

    fn lit(s: &str) -> Part {
        Part::Lit(s.into())
    }
    fn var(s: &str) -> Part {
        Part::Url { url: s.into() }
    }
    fn p(kv: &[(&str, &str)]) -> HashMap<String, String> {
        kv.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect()
    }

    #[test]
    fn params_from_query_and_path() {
        let pats = vec!["/".to_string(), "/article/:slug".to_string()];
        let u = url_params("/article/a%20b", Some("x=1&x=2&q=a+b"), &pats);
        assert_eq!(u["slug"], "a b");
        assert_eq!(u["x"], "2");
        assert_eq!(u["q"], "a b");
        // a path segment wins over a query parameter of the same name
        assert_eq!(url_params("/article/s", Some("slug=q"), &pats)["slug"], "s");
        assert!(url_params("/other/s", None, &pats).is_empty());
    }

    #[test]
    fn expand_as_the_runtime() {
        let t = [lit("/api/articles?tag="), var("tag"), lit("&limit=10")];
        assert_eq!(expand(&t, &p(&[("tag", "a&b")])).unwrap(), "/api/articles?tag=a%26b&limit=10");
        // absent: the parameter and its separator go
        assert_eq!(expand(&t, &p(&[])).unwrap(), "/api/articles?limit=10");
        let t = [lit("/api/x?a=1&b="), var("b")];
        assert_eq!(expand(&t, &p(&[])).unwrap(), "/api/x?a=1");
        let t = [lit("/api/x?b="), var("b")];
        assert_eq!(expand(&t, &p(&[])).unwrap(), "/api/x");
        // path values: encoded, a dot segment refused
        let t = [lit("/api/articles/"), var("slug"), lit("/comments")];
        assert_eq!(expand(&t, &p(&[("slug", "é/x")])).unwrap(), "/api/articles/%C3%A9%2Fx/comments");
        assert_eq!(expand(&t, &p(&[("slug", "..")])), None);
        assert_eq!(expand(&t, &p(&[])).unwrap(), "/api/articles//comments");
        assert_eq!(encode_segment("a'b(c)*!~"), "a'b(c)*!~");
    }

    #[test]
    fn to_page_as_parse_int() {
        for (v, n) in [
            (Some("3"), 3),
            (Some(" 3x"), 3),
            (Some("+2"), 2),
            (Some("0"), 1),
            (Some("-4"), 1),
            (Some("abc"), 1),
            (Some(""), 1),
            (None, 1),
            (Some("2.9"), 2),
        ] {
            assert_eq!(to_page(v), n, "{v:?}");
        }
    }

    #[test]
    fn with_params_as_the_runtime() {
        let q = |kv: &[(&str, &str)]| kv.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect::<Vec<_>>();
        // added in order; the query written as a form (a space as `+`)
        assert_eq!(with_params("/api/m", &q(&[("page", "1"), ("limit", "10")])), "/api/m?page=1&limit=10");
        assert_eq!(with_params("/api/m?tag=a%20b", &q(&[("limit", "10")])), "/api/m?tag=a+b&limit=10");
        // a parameter of the same name: replaced where it was, its repeats dropped
        assert_eq!(with_params("/api/m?limit=5&x=1&limit=6", &q(&[("limit", "10")])), "/api/m?limit=10&x=1");
        assert_eq!(with_params("/api/m#top", &q(&[("n", "1")])), "/api/m?n=1#top");
        assert_eq!(with_params("/api/m?x=1", &[]), "/api/m?x=1");
        // the form's own encoding, as URLSearchParams writes it
        assert_eq!(with_params("/api/m?q=é*~'()!", &q(&[("n", "1")])), "/api/m?q=%C3%A9*%7E%27%28%29%21&n=1");
    }
}
