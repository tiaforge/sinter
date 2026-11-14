using System.Net;
using System.Net.Http.Headers;
using System.Text;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.Logging;
using Sinter.AspNetCore.Manifest;

namespace Sinter.AspNetCore;

/// <summary>A page cut at its placeholders: <c>Parts[i]</c> comes before <c>Slots[i]</c>, the last part after them all.</summary>
internal sealed class Page(string file, string[] paths, byte[][] parts, ManifestSlot[] slots, string[] arrays)
{
    public string File { get; } = file;
    public string[] Paths { get; } = paths;
    public string[] Arrays { get; } = arrays;
    public byte[][] Parts { get; } = parts;
    public ManifestSlot[] Slots { get; } = slots;
    public int Length { get; } = parts.Sum(p => p.Length);
}

/// <summary>What became of one placeholder's data.</summary>
internal readonly struct Fill
{
    public enum Kind : byte { Browser, Data, Failed }
    private Fill(Kind k, ReadOnlyMemory<byte> data, int status) { What = k; Data = data; Status = status; }
    public Kind What { get; }
    public ReadOnlyMemory<byte> Data { get; }
    public int Status { get; }
    /// <summary>None from the server (a resolver's None, a skip, a <c>when</c> that does not hold): the browser requests it.</summary>
    public static Fill Browser => default;
    public static Fill Of(ReadOnlyMemory<byte> data) => new(Kind.Data, data, 0);
    /// <summary>The request failed (502) or ran out of time (504): the page is not sent.</summary>
    public static Fill Failed(int status) => new(Kind.Failed, default, status);
}

/// <summary>A configuration checked against its build: everything a request needs, computed once.</summary>
internal sealed partial class SinterEngine
{
    public Page[] Pages { get; }
    public ManifestRoute[] Routes { get; }
    public ManifestLocales? Locales { get; }
    public SinterOptions Options { get; }
    /// <summary>What ends a streamed page whose data failed, from inside its placeholder's <c>&lt;script&gt;</c>.</summary>
    public byte[] StreamTail { get; }
    /// <summary>The whole document sent instead of an unstreamed page whose data failed.</summary>
    public byte[] ErrorDocument { get; }
    public InProcessApi? Api { get; set; }

    private readonly PathTable _pages = new();
    private readonly PathTable _routes = new();
    private readonly string[] _forward;
    private readonly HttpClient _http;
    private readonly ILogger _log;

    public SinterEngine(SinterOptions options, string contentRoot, ILogger log)
    {
        Options = options;
        _log = log;
        var dir = options.Dir ?? options.Compiled?.Dir
            ?? throw new SinterException("no build directory: set SinterOptions.Dir, or use [SinterEmbed] and AddSinter(YourClass.Build)");
        dir = Path.GetFullPath(Path.Combine(contentRoot, dir));
        var manifest = Load(dir, options.Compiled);
        Check(manifest);
        Pages = manifest.Pages.Select(p =>
        {
            var file = Path.Combine(dir, p.File);
            byte[] html;
            try { html = File.ReadAllBytes(file); }
            catch (Exception e) when (e is IOException or UnauthorizedAccessException) { throw new SinterException($"{file}: {e.Message}"); }
            try { return Split(html, p); }
            catch (SinterException e) { throw new SinterException($"{file}: {e.Detail}"); }
        }).ToArray();
        for (var i = 0; i < Pages.Length; i++)
            foreach (var pat in Pages[i].Paths) _pages.Add(i, pat, exact: false);
        Routes = manifest.Routes;
        for (var i = 0; i < Routes.Length; i++) _routes.Add(i, Routes[i].From, exact: Routes[i].Status != 200);
        Locales = manifest.Locales;
        _forward = options.Forward.ToArray();
        _http = options.HttpClient ?? new HttpClient(new SocketsHttpHandler
        {
            PooledConnectionLifetime = TimeSpan.FromMinutes(2),
            AutomaticDecompression = DecompressionMethods.All,
        });
        var tail = ErrorTail(options);
        StreamTail = Encoding.UTF8.GetBytes("</script>" + tail);
        ErrorDocument = Encoding.UTF8.GetBytes("<!DOCTYPE html><html><head><meta charset=\"utf-8\">" + tail);
    }

    /// <summary>The page for a path: the first, in the manifest's order, with a path that matches.</summary>
    public int Page(string path) => _pages.Find(path);

    /// <summary>The rule for a path: a redirect for exactly its <c>from</c>, a rewrite for a path its pattern matches.</summary>
    public ManifestRoute? Route(string path) => _routes.Find(path) is var i and >= 0 ? Routes[i] : null;

    private static SinterManifest Load(string dir, SinterCompiledBuild? compiled)
    {
        var at = Path.Combine(dir, ManifestReader.File);
        string text;
        try { text = File.ReadAllText(at); }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException)
        {
            throw new SinterException($"{at}: {e.Message} (built with sinter's Vite plugin, with `embed: true` or a `data-sn-data` placeholder?)");
        }
        if (compiled is not null)
        {
            if (ManifestReader.Fingerprint(text) != compiled.Fingerprint)
                throw new SinterException($"{at} is not the build this assembly was compiled against ([SinterEmbed]): build the frontend and the server from the same source");
            return compiled.Manifest;
        }
        try { return ManifestReader.Parse(text); }
        catch (Exception e) when (e is SinterException or System.Text.Json.JsonException or InvalidOperationException or FormatException or KeyNotFoundException)
        {
            var why = e is SinterException se ? se.Detail : e.Message;
            throw new SinterException($"{at}: {why}");
        }
    }

    /// <summary>Every placeholder has a source: a resolver, a skip, or a request this configuration can make; every name is a placeholder's.</summary>
    private void Check(SinterManifest m)
    {
        var problems = new List<string>();
        var names = new HashSet<string>(StringComparer.Ordinal);
        foreach (var p in m.Pages)
            foreach (var s in p.Data) { names.Add(s.Resource); names.Add($"{p.File}:{s.Resource}"); }
        foreach (var n in Options.Resolvers.Keys.Concat(Options.Skips))
            if (!names.Contains(n)) problems.Add($"`{n}`: no page of the build has a placeholder for it");
        foreach (var p in m.Pages)
            foreach (var s in p.Data)
            {
                var key = $"{p.File}:{s.Resource}";
                if (Options.Resolvers.ContainsKey(key) || Options.Resolvers.ContainsKey(s.Resource) || Options.Skips.Contains(key) || Options.Skips.Contains(s.Resource))
                    continue;
                if (Source(s) is { } why)
                    problems.Add($"{p.File}: `{s.Resource}`: {why}; add Resolve(\"{s.Resource}\", …) or Skip(\"{s.Resource}\")");
            }
        if (problems.Count > 0)
            throw new SinterException($"{problems.Count} placeholder(s) have no source:\n  {string.Join("\n  ", problems)}");
    }

    /// <summary>Why this configuration cannot make the request the build describes for a placeholder, or null if it can.</summary>
    private string? Source(ManifestSlot s)
    {
        if (!s.Described)
            return s.Src is null
                ? "the build could not describe its request (its `src` calls a helper, or reads something other than `$url`)"
                : "its `when` is a condition only the browser can evaluate";
        var first = s.Src is [{ IsUrl: false } f, ..] ? f.Value : "";
        if (first.StartsWith('/') && !first.StartsWith("//"))
            return Options.Upstream is not null || Options.InProcess ? null : $"`{first}…` is a path of this origin, and there is no Upstream and InProcess is off";
        return Allowed(first) ? null : $"`{first}…` is on an origin not allowed with AllowOrigin(…)";
    }

    private bool Allowed(string url)
    {
        foreach (var o in Options.Origins)
            if (url.StartsWith(o, StringComparison.Ordinal) && (url.Length == o.Length || url[o.Length] is '/' or '?')) return true;
        return false;
    }

    /// <summary>Cuts the page at each placeholder, in document order; one that is missing or not empty means the HTML and the manifest are from different builds.</summary>
    internal static Page Split(byte[] html, ManifestPage p)
    {
        var at = new List<(int Start, int End, ManifestSlot Slot)>();
        foreach (var s in p.Data)
        {
            var open = Encoding.UTF8.GetBytes($"<script type=\"application/json\" data-sn=\"{s.Id}\">");
            var i = html.AsSpan().IndexOf(open);
            if (i < 0)
                throw new SinterException($"no placeholder for `{s.Resource}` (data-sn=\"{s.Id}\"): the page and sinter-embed.json are from different builds");
            var j = i + open.Length;
            if (!html.AsSpan(j).StartsWith("</script>"u8)) throw new SinterException($"the placeholder for `{s.Resource}` is not empty");
            at.Add((i, j, s));
        }
        at.Sort((a, b) => a.Start.CompareTo(b.Start));
        var parts = new byte[at.Count + 1][];
        var from = 0;
        for (var k = 0; k < at.Count; k++)
        {
            parts[k] = html[from..at[k].End];
            from = at[k].End;
        }
        parts[^1] = html[from..];
        return new Page(p.File, p.Paths, parts, at.Select(x => x.Slot).ToArray(), p.Arrays);
    }

    /// <summary>The end of a page whose data failed, from inside its head: a redirect to the error page if there is one, then a body with the text.</summary>
    private static string ErrorTail(SinterOptions o)
    {
        static string Html(string v) => v.Replace("&", "&amp;").Replace("<", "&lt;").Replace(">", "&gt;").Replace("\"", "&quot;");
        var go = "";
        if (o.ErrorRedirect is { } u)
        {
            var js = System.Text.Json.JsonEncodedText.Encode(u, System.Text.Encodings.Web.JavaScriptEncoder.UnsafeRelaxedJsonEscaping).ToString().Replace("<", "\\u003c");
            go = $"<meta http-equiv=\"refresh\" content=\"0;url={Html(u)}\"><script>location.replace(\"{js}\")</script>";
        }
        return $"{go}</head><body data-sn-failed><p>{Html(o.ErrorText)}</p></body></html>";
    }

    /// <summary>The request the build describes for a placeholder at this URL, if any and if its <c>when</c> holds.</summary>
    public static string? DescribedUrl(ManifestSlot s, IReadOnlyDictionary<string, UrlParam> p)
    {
        if (s.When is { } c && !c.Holds(p)) return null;
        if (s.Src is null || SinterUrl.Expand(s.Src, p) is not { } url) return null;
        return SinterUrl.WithParams(url, s.Start is { } start ? start.Params(s.Query, p) : s.Query);
    }

    /// <summary>The data for one placeholder. Never throws: a failure is <see cref="Fill.Failed"/>.</summary>
    public async Task<Fill> FillAsync(SlotRequest r)
    {
        var o = Options;
        var key = $"{r.Page}:{r.Resource}";
        try
        {
            if (o.Resolvers.TryGetValue(key, out var f) || o.Resolvers.TryGetValue(r.Resource, out f))
            {
                var d = await f(r).ConfigureAwait(false);
                return d.HasValue ? Fill.Of(d.Json) : Fill.Browser;
            }
            if (o.Skips.Contains(key) || o.Skips.Contains(r.Resource)) return Fill.Browser;
            // no request at this URL (its `when` does not hold)
            if (r.Url is not { } url) return Fill.Browser;
            ReadOnlyMemory<byte>? body = null;
            string? why = null;
            // a path of this origin; `//host` is another origin
            if (url.StartsWith('/') && !url.StartsWith("//"))
            {
                if (o.Upstream is { } up) (body, why) = await GetAsync(up + url, r.HttpContext, forward: true, r.StaticHeaders, r.Cancellation).ConfigureAwait(false);
                else if (o.InProcess && Api is { } api) (body, why) = await api.GetAsync(r.HttpContext, url, _forward, o.MaxBytes, r.Cancellation, r.StaticHeaders).ConfigureAwait(false);
                else return Fill.Browser; // the startup check refuses a configuration without a source
            }
            else if (Allowed(url)) (body, why) = await GetAsync(url, r.HttpContext, forward: false, r.StaticHeaders, r.Cancellation).ConfigureAwait(false);
            else return Fill.Browser;
            if (body is { } b) return Fill.Of(b);
            Log.Failed(_log, r.Page, r.Resource, url, why ?? "no response");
            return Fill.Failed(StatusCodes.Status502BadGateway);
        }
        catch (OperationCanceledException) when (r.Cancellation.IsCancellationRequested)
        {
            return Fill.Failed(StatusCodes.Status504GatewayTimeout);
        }
        catch (Exception e)
        {
            Log.Threw(_log, r.Page, r.Resource, e);
            return Fill.Failed(StatusCodes.Status502BadGateway);
        }
    }

    /// <summary>Over HTTP: the body of a 2xx JSON response within MaxBytes, else why not.</summary>
    private async Task<(ReadOnlyMemory<byte>?, string?)> GetAsync(string url, HttpContext page, bool forward, KeyValuePair<string, string>[] own, CancellationToken ct)
    {
        using var req = new HttpRequestMessage(HttpMethod.Get, url);
        if (forward)
            foreach (var n in _forward)
                if (page.Request.Headers.TryGetValue(n, out var v)) req.Headers.TryAddWithoutValidation(n, (IEnumerable<string?>)v);
        // the API's static headers the request does not have already
        foreach (var (k, v) in own)
            if (!req.Headers.Contains(k)) req.Headers.TryAddWithoutValidation(k, v);
        req.Headers.Accept.Add(new MediaTypeWithQualityHeaderValue("application/json"));
        using var res = await _http.SendAsync(req, HttpCompletionOption.ResponseHeadersRead, ct).ConfigureAwait(false);
        if (!res.IsSuccessStatusCode) return (null, $"status {(int)res.StatusCode}");
        if (!IsJson(res.Content.Headers.ContentType?.MediaType)) return (null, "not JSON");
        var max = Options.MaxBytes;
        if (res.Content.Headers.ContentLength > max) return (null, $"over {max} bytes");
        using var s = await res.Content.ReadAsStreamAsync(ct).ConfigureAwait(false);
        var buf = new MemoryStream();
        var chunk = new byte[16 * 1024];
        int n2;
        while ((n2 = await s.ReadAsync(chunk, ct).ConfigureAwait(false)) > 0)
        {
            if (buf.Length + n2 > max) return (null, $"over {max} bytes");
            buf.Write(chunk, 0, n2);
        }
        return (buf.GetBuffer().AsMemory(0, (int)buf.Length), null);
    }

    internal static bool IsJson(string? contentType)
    {
        if (contentType is null) return false;
        var t = contentType.AsSpan();
        var semi = t.IndexOf(';');
        if (semi >= 0) t = t[..semi];
        t = t.Trim();
        return t.Equals("application/json", StringComparison.OrdinalIgnoreCase) || t.EndsWith("+json", StringComparison.OrdinalIgnoreCase);
    }

    private static partial class Log
    {
        [LoggerMessage(1, LogLevel.Warning, "sinter: {Page}: `{Resource}`: {Url}: {Why}; the page ends with the error text")]
        public static partial void Failed(ILogger log, string page, string resource, string url, string why);

        [LoggerMessage(2, LogLevel.Error, "sinter: {Page}: `{Resource}`: the resolver threw; the page ends with the error text")]
        public static partial void Threw(ILogger log, string page, string resource, Exception e);
    }
}

/// <summary>
/// Paths to rules, first in their order: exact paths and literal patterns in dictionaries (by the path's
/// non-empty segments), <c>:name</c> patterns by segment count.
/// </summary>
internal sealed class PathTable
{
    private readonly Dictionary<string, int> _exact = new(StringComparer.Ordinal);
    private readonly Dictionary<string, int> _literal = new(StringComparer.Ordinal);
    private readonly List<(int Index, string Pattern, int Count)> _patterns = [];

    public void Add(int index, string pattern, bool exact)
    {
        if (exact) _exact.TryAdd(pattern, index);
        else if (pattern.Contains(':')) _patterns.Add((index, pattern, Count(pattern)));
        else _literal.TryAdd(Normalize(pattern), index);
    }

    public int Find(string path)
    {
        var best = int.MaxValue;
        if (_exact.Count > 0 && _exact.TryGetValue(path, out var e)) best = e;
        if (_literal.Count > 0 && _literal.TryGetValue(Normalize(path), out var l) && l < best) best = l;
        if (_patterns.Count > 0)
        {
            var n = Count(path);
            foreach (var (i, pat, c) in _patterns)
            {
                if (i >= best) break;
                if (c == n && SinterUrl.Matches(pat, path)) { best = i; break; }
            }
        }
        return best == int.MaxValue ? -1 : best;
    }

    private static int Count(string path)
    {
        var s = new SinterUrl.Segments(path);
        var n = 0;
        while (s.Next(out _)) n++;
        return n;
    }

    /// <summary>The path's non-empty segments joined by <c>/</c>; the path itself when it already is that.</summary>
    private static string Normalize(string path)
    {
        var p = path.AsSpan();
        if (p.Length > 1 && p[0] == '/' && p[^1] != '/' && !p.Contains("//", StringComparison.Ordinal)) return path;
        var b = new StringBuilder(path.Length);
        var s = new SinterUrl.Segments(path);
        while (s.Next(out var seg)) b.Append('/').Append(seg);
        return b.Length == 0 ? "/" : b.ToString();
    }
}
