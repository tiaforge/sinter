//! `embed!` for sinter-axum: reads a sinter build's `sinter-embed.json` when the crate compiles and
//! refuses a configuration that leaves a data placeholder without a source.

use proc_macro::TokenStream;
use quote::quote;
use syn::{
    Expr, LitStr, Token, braced,
    parse::{Parse, ParseStream},
    parse_macro_input,
    punctuated::Punctuated,
};

struct Entry {
    key: LitStr,
    /// None: `skip`
    resolver: Option<Expr>,
}

impl Parse for Entry {
    fn parse(input: ParseStream) -> syn::Result<Self> {
        let key: LitStr = input.parse()?;
        input.parse::<Token![=>]>()?;
        let e: Expr = input.parse()?;
        let skip = matches!(&e, Expr::Path(p) if p.qself.is_none() && p.path.is_ident("skip"));
        Ok(Entry { key, resolver: if skip { None } else { Some(e) } })
    }
}

struct Input {
    dir: LitStr,
    entries: Vec<Entry>,
}

impl Parse for Input {
    fn parse(input: ParseStream) -> syn::Result<Self> {
        let dir: LitStr = input.parse()?;
        let mut entries = Vec::new();
        if input.parse::<Option<Token![,]>>()?.is_some() && !input.is_empty() {
            let body;
            braced!(body in input);
            entries = Punctuated::<Entry, Token![,]>::parse_terminated(&body)?.into_iter().collect();
            input.parse::<Option<Token![,]>>()?;
        }
        Ok(Input { dir, entries })
    }
}

/// One placeholder as the check sees it.
struct Slot {
    page: String,
    resource: String,
    /// why the build could not describe its request, if it could not
    undescribed: Option<&'static str>,
}

fn slots(manifest: &serde_json::Value) -> Result<Vec<Slot>, String> {
    if manifest.get("version").and_then(|v| v.as_u64()) != Some(2) {
        return Err("not a sinter-embed.json of version 2".into());
    }
    let mut out = Vec::new();
    for p in manifest.get("pages").and_then(|v| v.as_array()).ok_or("no `pages`")? {
        let page = p.get("file").and_then(|v| v.as_str()).ok_or("a page without `file`")?;
        for d in p.get("data").and_then(|v| v.as_array()).ok_or("a page without `data`")? {
            let resource = d.get("resource").and_then(|v| v.as_str()).ok_or("a placeholder without `resource`")?;
            let undescribed = if d.get("src").is_none_or(|v| v.is_null()) {
                Some("the build could not describe its request (its `src` calls a helper, or reads something other than `$url`)")
            } else if d.get("when").is_some_and(|w| w.as_bool() == Some(true)) {
                Some("its `when` is a condition only the browser can evaluate")
            } else {
                None
            };
            out.push(Slot { page: page.into(), resource: resource.into(), undescribed });
        }
    }
    Ok(out)
}

/// `embed!("../web/dist", { "articles" => resolver, "user" => skip })`: a `sinter_axum::Embed` for
/// that build, with those resolvers and skips. A compile error when a placeholder has neither a
/// request the build describes nor an entry, or an entry names no placeholder. The path is
/// relative to the crate's `Cargo.toml`.
#[proc_macro]
pub fn embed(input: TokenStream) -> TokenStream {
    let Input { dir, entries } = parse_macro_input!(input as Input);
    let root = std::env::var("CARGO_MANIFEST_DIR").unwrap_or_default();
    let abs = std::path::Path::new(&root).join(dir.value());
    let file = abs.join("sinter-embed.json");
    let text = match std::fs::read_to_string(&file) {
        Ok(t) => t,
        Err(e) => {
            let msg = format!("{}: {e}. Build the frontend first, with `sinter({{ embed: true }})`", file.display());
            return syn::Error::new(dir.span(), msg).to_compile_error().into();
        }
    };
    let slots = match serde_json::from_str::<serde_json::Value>(&text).map_err(|e| e.to_string()).and_then(|m| slots(&m)) {
        Ok(s) => s,
        Err(e) => return syn::Error::new(dir.span(), format!("{}: {e}", file.display())).to_compile_error().into(),
    };
    let mut errors: Option<syn::Error> = None;
    let mut push = |e: syn::Error| match &mut errors {
        Some(all) => all.combine(e),
        None => errors = Some(e),
    };
    for e in &entries {
        let k = e.key.value();
        if !slots.iter().any(|s| s.resource == k || format!("{}:{}", s.page, s.resource) == k) {
            let names: Vec<String> =
                slots.iter().map(|s| format!("`{}`", s.resource)).collect::<std::collections::BTreeSet<_>>().into_iter().collect();
            push(syn::Error::new(e.key.span(), format!("no page of the build has a placeholder for `{k}` (it has {})", names.join(", "))));
        }
    }
    let covered = |s: &Slot| entries.iter().any(|e| e.key.value() == s.resource || e.key.value() == format!("{}:{}", s.page, s.resource));
    for s in &slots {
        if let (Some(why), false) = (s.undescribed, covered(s)) {
            push(syn::Error::new(
                dir.span(),
                format!(
                    "{}: `{}`: {why}. Add `\"{}\" => |req| async move {{ … }}` to give its data, or `\"{}\" => skip` to leave it to the browser",
                    s.page, s.resource, s.resource, s.resource
                ),
            ));
        }
    }
    if let Some(e) = errors {
        return e.to_compile_error().into();
    }
    let (abs_dir, abs_file) = (abs.to_string_lossy().into_owned(), file.to_string_lossy().into_owned());
    let calls = entries.iter().map(|e| {
        let k = &e.key;
        match &e.resolver {
            Some(f) => quote! { .resolve(#k, #f) },
            None => quote! { .skip(#k) },
        }
    });
    quote! {
        ::sinter_axum::Embed::__compiled(#abs_dir, ::core::include_str!(#abs_file)) #(#calls)*
    }
    .into()
}
