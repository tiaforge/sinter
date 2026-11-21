// `sinter-embed.json`, which the sinter Vite plugin writes next to the built pages. Public so that the
// source generator can compile a build's manifest into the assembly ([SinterEmbed]); not meant to be
// written by hand.
using System.ComponentModel;

namespace Sinter.AspNetCore.Manifest;

/// <summary>A build's <c>sinter-embed.json</c> (version 2).</summary>
[EditorBrowsable(EditorBrowsableState.Never)]
public sealed class SinterManifest(ManifestPage[] pages, ManifestRoute[] routes, ManifestLocales? locales, IReadOnlyDictionary<string, ManifestOrigin>? origins = null)
{
    /// <summary>The pages that have placeholders.</summary>
    public ManifestPage[] Pages { get; } = pages;
    /// <summary>The site's URLs, as the build's <c>_redirects</c> has them: 301s and rewrites to a page's file.</summary>
    public ManifestRoute[] Routes { get; } = routes;
    /// <summary><c>localePrefix</c>: the site's languages; an unprefixed URL (a <c>choose</c> route) is sent to one of them.</summary>
    public ManifestLocales? Locales { get; } = locales;
    /// <summary>Tenants on their own domains: each domain (<c>acme-shop.com</c>), its folder, and the folder's top-level entries.</summary>
    public IReadOnlyDictionary<string, ManifestOrigin> Origins { get; } = origins ?? new Dictionary<string, ManifestOrigin>();
}

/// <summary>A tenant's domain: its folder, and the first segments of the paths that are that folder's (<c>de</c>, <c>about</c>).</summary>
[EditorBrowsable(EditorBrowsableState.Never)]
public sealed class ManifestOrigin(string folder, string[] top)
{
    /// <summary>The folder its files are in.</summary>
    public string Folder { get; } = folder;
    /// <summary>The folder's top-level entries: a request whose first segment is one of them (or <c>/</c>) is the folder's.</summary>
    public string[] Top { get; } = top;
}

/// <summary>A page: its HTML file relative to the build's output, the paths it answers at, its placeholders.</summary>
[EditorBrowsable(EditorBrowsableState.Never)]
public sealed class ManifestPage(string file, string[] paths, ManifestPlaceholder[] data, string[]? arrays = null)
{
    /// <summary>Its array parameters: <c>$url</c> values read as lists (repeated keys).</summary>
    public string[] Arrays { get; } = arrays ?? [];
    /// <summary>The HTML file, relative to the build's output directory.</summary>
    public string File { get; } = file;
    /// <summary>The paths it answers at: <c>data-sn-path</c> patterns, else where its file is served.</summary>
    public string[] Paths { get; } = paths;
    /// <summary>Its placeholders.</summary>
    public ManifestPlaceholder[] Data { get; } = data;
}

/// <summary>One placeholder: <c>&lt;script type="application/json" data-sn="{id}"&gt;&lt;/script&gt;</c> in the page's head.</summary>
[EditorBrowsable(EditorBrowsableState.Never)]
public sealed class ManifestPlaceholder(int id, string resource, UrlPart[]? src, bool whenInBrowser, Cond? when, KeyValuePair<string, string>[] query, ManifestStart? start, KeyValuePair<string, string>[]? headers = null)
{
    /// <summary>Its <c>data-sn</c> id.</summary>
    public int Id { get; } = id;
    /// <summary>The resource's name.</summary>
    public string Resource { get; } = resource;
    /// <summary>The resource's URL template, when only literals and <c>$url</c> reads make it up; else null.</summary>
    public UrlPart[]? Src { get; } = src;
    /// <summary><c>when: true</c>: a condition only the browser can evaluate.</summary>
    public bool WhenInBrowser { get; } = whenInBrowser;
    /// <summary>The resource's <c>when</c>, as a condition over <c>$url</c>.</summary>
    public Cond? When { get; } = when;
    /// <summary>Paginated: the first page's query parameters, set on the template's URL.</summary>
    public KeyValuePair<string, string>[] Query { get; } = query;
    /// <summary>Paginated, starting at a page from <c>$url</c> (<c>model</c> (paginate)).</summary>
    public ManifestStart? Start { get; } = start;
    /// <summary>The static headers of the resource's API (<c>sinter({ apis })</c>): sent with this layer's request for it.</summary>
    public KeyValuePair<string, string>[] Headers { get; } = headers ?? [];

    /// <summary>Whether the build describes the request completely: its URL, and its <c>when</c> if it has one.</summary>
    public bool Described => Src is not null && !WhenInBrowser;
}

/// <summary>A piece of a URL template: literal text, or a <c>$url</c> value.</summary>
public readonly record struct UrlPart(string Value, bool IsUrl)
{
    /// <summary>Literal text.</summary>
    public static UrlPart Lit(string text) => new(text, false);
    /// <summary>The value of <c>$url.name</c>.</summary>
    public static UrlPart Url(string name) => new(name, true);
}

/// <summary>A <c>when</c> over <c>$url</c> values, as JavaScript evaluates it: an absent value is <c>undefined</c>, an empty string is falsy.</summary>
[EditorBrowsable(EditorBrowsableState.Never)]
public abstract class Cond
{
    private protected Cond() { }
    /// <summary>Whether it holds for the page URL's parameters.</summary>
    public abstract bool Holds(IReadOnlyDictionary<string, UrlParam> p);

    /// <summary><c>!c</c></summary>
    public static Cond Not(Cond c) => new NotCond(c);
    /// <summary><c>a &amp;&amp; b …</c></summary>
    public static Cond And(params Cond[] all) => new AndCond(all);
    /// <summary><c>a || b …</c></summary>
    public static Cond Or(params Cond[] any) => new OrCond(any);
    /// <summary><c>$url.name</c> (present and not empty), or compared with a string: <c>==</c> <paramref name="eq"/>, <c>!=</c> <paramref name="ne"/>.</summary>
    public static Cond Url(string name, string? eq = null, string? ne = null) => new UrlCond(name, eq, ne);

    private sealed class NotCond(Cond c) : Cond
    {
        public override bool Holds(IReadOnlyDictionary<string, UrlParam> p) => !c.Holds(p);
    }
    private sealed class AndCond(Cond[] all) : Cond
    {
        public override bool Holds(IReadOnlyDictionary<string, UrlParam> p) => all.All(c => c.Holds(p));
    }
    private sealed class OrCond(Cond[] any) : Cond
    {
        public override bool Holds(IReadOnlyDictionary<string, UrlParam> p) => any.Any(c => c.Holds(p));
    }
    private sealed class UrlCond(string name, string? eq, string? ne) : Cond
    {
        // (a `when` that reads an array parameter is the browser's: the build never writes one as a condition)
        public override bool Holds(IReadOnlyDictionary<string, UrlParam> p)
        {
            var v = p.TryGetValue(name, out var x) ? x.Value : null;
            var has = v is not null;
            if (eq is not null) return has && v == eq;
            if (ne is not null) return !has || v != ne;
            return has && v!.Length > 0;
        }
    }
}

/// <summary><c>model</c> (paginate): the page from its <c>$url</c> parameter; from page 2 on, <c>query</c> with <c>key</c> set to the page (with <c>skip</c>, to the items to skip, <c>(page - 1) * size</c>).</summary>
[EditorBrowsable(EditorBrowsableState.Never)]
public sealed class ManifestStart(string url, string key, ulong size, bool skip, KeyValuePair<string, string>[] query)
{
    /// <summary>The <c>$url</c> value that names the page.</summary>
    public string Url { get; } = url;
    /// <summary>The query parameter set to the page (or the offset).</summary>
    public string Key { get; } = key;
    /// <summary>The page size.</summary>
    public ulong Size { get; } = size;
    /// <summary>Whether <see cref="Key"/> counts items to skip rather than pages.</summary>
    public bool Skip { get; } = skip;
    /// <summary>The parameters from page 2 on.</summary>
    public KeyValuePair<string, string>[] Query { get; } = query;

    /// <summary>The first page's query parameters for this request.</summary>
    public KeyValuePair<string, string>[] Params(KeyValuePair<string, string>[] first, IReadOnlyDictionary<string, UrlParam> p)
    {
        var n = SinterUrl.ToPage(p.TryGetValue(Url, out var v) ? v.Value : null);
        if (n <= 1) return first;
        ulong value = n;
        if (Skip)
        {
            value = n - 1;
            value = Size != 0 && value > ulong.MaxValue / Size ? ulong.MaxValue : value * Size;
        }
        var s = value.ToString(System.Globalization.CultureInfo.InvariantCulture);
        var o = new KeyValuePair<string, string>[Query.Length];
        for (var i = 0; i < Query.Length; i++)
            o[i] = Query[i].Key == Key ? new(Key, s) : Query[i];
        return o;
    }
}

/// <summary>One rule of the site's URLs: 301 from an old file URL to a page's URL; 200 from a path a page declares (<c>data-sn-path</c>) to its file.</summary>
[EditorBrowsable(EditorBrowsableState.Never)]
public sealed class ManifestRoute(string from, string to, int status, string? file, bool choose)
{
    /// <summary>The path, or a <c>:name</c> pattern for a 200.</summary>
    public string From { get; } = from;
    /// <summary>Where it goes.</summary>
    public string To { get; } = to;
    /// <summary>301 (or another redirect), or 200 for a rewrite.</summary>
    public int Status { get; } = status;
    /// <summary>For a rewrite: the page's file in the build's output.</summary>
    public string? File { get; } = file;
    /// <summary>An unprefixed URL of a site with languages: the middleware redirects to the visitor's.</summary>
    public bool Choose { get; } = choose;
}

/// <summary>The site's languages, each a prefix of its URLs (<c>/de/…</c>), and the one a visitor without a choice gets.</summary>
[EditorBrowsable(EditorBrowsableState.Never)]
public sealed class ManifestLocales(string @base, string[] list, string at, IReadOnlyDictionary<string, string>? paths = null, IReadOnlyDictionary<string, string[]>? codes = null)
{
    /// <summary>The language a visitor without a choice gets.</summary>
    public string Base { get; } = @base;
    /// <summary>The site's languages.</summary>
    public string[] List { get; } = list;
    /// <summary>Where the site's paths start (Vite's <c>base</c>): the language's prefix goes after it.</summary>
    public string At { get; } = at;
    /// <summary>A language's URL segment where it is not its tag (<c>languages({ paths })</c>).</summary>
    public IReadOnlyDictionary<string, string> Paths { get; } = paths ?? new Dictionary<string, string>();
    /// <summary>More tags a visitor may send for a language (<c>languages({ codes })</c>).</summary>
    public IReadOnlyDictionary<string, string[]> Codes { get; } = codes ?? new Dictionary<string, string[]>();
    /// <summary>A language's URL segment: its <see cref="Paths"/> entry, else its tag.</summary>
    public string Segment(string lang) => Paths.TryGetValue(lang, out var s) ? s : lang;
}
