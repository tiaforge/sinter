// `$url` and URL templates, as sinter's runtime computes them (src/runtime/url.ts), so the request the
// server makes for a placeholder is the one the page would have made. A port of sinter-axum's url.rs.
using System.Buffers;
using System.Globalization;
using System.Text;
using Sinter.AspNetCore.Manifest;

namespace Sinter.AspNetCore;

/// <summary>
/// A <c>$url</c> parameter: one value, or a list for an array parameter (bound to a <c>&lt;select multiple&gt;</c>
/// or a checkbox with a <c>value</c>, written as repeated keys: <c>?tag=a&amp;tag=b</c>).
/// </summary>
public sealed class UrlParam
{
    private readonly string[]? _list;
    private UrlParam(string? value, string[]? list) { Value = value; _list = list; }

    /// <summary>One value.</summary>
    public static UrlParam One(string value) => new(value, null);
    /// <summary>An array parameter's values.</summary>
    public static UrlParam List(IEnumerable<string> values) => new(null, values.ToArray());

    /// <summary>The value of a parameter that is one; null for a list.</summary>
    public string? Value { get; }
    /// <summary>Whether it is an array parameter's list.</summary>
    public bool IsList => _list is not null;
    /// <summary>The values: the list's, or the one.</summary>
    public IReadOnlyList<string> Values => _list ?? new[] { Value! };

    /// <inheritdoc/>
    public override string ToString() => _list is null ? Value! : string.Join(",", _list);
}

/// <summary>sinter's URL rules, as the browser runtime applies them.</summary>
public static class SinterUrl
{
    /// <summary>Whether a <c>data-sn-path</c> pattern (<c>/article/:slug</c>) matches the path: as many segments, and the literal ones equal.</summary>
    public static bool Matches(string pattern, string path)
    {
        var w = new Segments(pattern);
        var s = new Segments(path);
        while (true)
        {
            var hw = w.Next(out var a);
            var hs = s.Next(out var b);
            if (!hw || !hs) return hw == hs;
            if (!(a.Length > 0 && a[0] == ':') && !a.SequenceEqual(b)) return false;
        }
    }

    /// <summary>
    /// <c>$url</c>: the query parameters (the last of a repeated name; an array parameter, every one, an empty
    /// list when absent), then the <c>:name</c> segments of the first pattern that matches the path.
    /// <paramref name="path"/> is decoded as ASP.NET Core decodes it (an encoded <c>/</c> stays <c>%2F</c>),
    /// <paramref name="query"/> as sent. Names that could reach prototypes in the browser are dropped, as there.
    /// </summary>
    public static Dictionary<string, UrlParam> UrlParams(string path, string? query, IReadOnlyList<string> patterns, IReadOnlyList<string>? arrays = null)
    {
        var o = new Dictionary<string, UrlParam>(StringComparer.Ordinal);
        var lists = new Dictionary<string, List<string>>(StringComparer.Ordinal);
        foreach (var k in arrays ?? Array.Empty<string>()) if (!BadKey(k)) lists[k] = [];
        if (!string.IsNullOrEmpty(query))
            foreach (var (k, v) in ParseForm(query))
            {
                if (BadKey(k)) continue;
                if (lists.TryGetValue(k, out var l)) l.Add(v);
                else o[k] = UrlParam.One(v);
            }
        foreach (var (k, l) in lists) o[k] = UrlParam.List(l);
        foreach (var p in patterns)
        {
            if (!Matches(p, path)) continue;
            var w = new Segments(p);
            var s = new Segments(path);
            while (w.Next(out var a) && s.Next(out var b))
                if (a.Length > 0 && a[0] == ':')
                    o[a[1..].ToString()] = UrlParam.One(b.ToString().Replace("%2F", "/").Replace("%2f", "/"));
            break;
        }
        return o;
    }

    private static bool BadKey(string k) => k is "constructor" or "__proto__" or "prototype";

    /// <summary>
    /// Fills a URL template from <c>$url</c>. An absent value (or an empty list) leaves its query parameter out
    /// (with its <c>&amp;</c>), or is empty elsewhere; a list that is a whole query value is a repeated key,
    /// elsewhere in the query its values joined with <c>,</c> (as JavaScript writes an array); a path value of
    /// <c>.</c> or <c>..</c>, or a list, is refused (null), as in the browser.
    /// </summary>
    public static string? Expand(IReadOnlyList<UrlPart> parts, IReadOnlyDictionary<string, UrlParam> p)
    {
        var o = new StringBuilder();
        bool query = false, dropped = false;
        for (var i = 0; i < parts.Count; i++)
        {
            var part = parts[i];
            if (!part.IsUrl)
            {
                var s = part.Value;
                // after a dropped parameter, its `&` separator goes too
                if (dropped && s.StartsWith('&') && o.Length > 0 && o[^1] is '?' or '&') o.Append(s, 1, s.Length - 1);
                else o.Append(s);
                dropped = false;
                query |= s.AsSpan().IndexOfAny('?', '#') >= 0;
                continue;
            }
            var whole = query && (i + 1 >= parts.Count || (!parts[i + 1].IsUrl && parts[i + 1].Value.Length > 0 && parts[i + 1].Value[0] is '&' or '#'));
            var key = whole ? TrailingKey(o) : -1;
            UrlParam? param = p.TryGetValue(part.Value, out var found) ? found : null;
            if (param is { IsList: true })
            {
                if (!query) return null;
                var l = param.Values;
                if (key >= 0 && l.Count > 0)
                {
                    var name = o.ToString(key, o.Length - key - 1);
                    for (var j = 0; j < l.Count; j++) o.Append(j > 0 ? $"&{name}=" : "").Append(EncodeSegment(l[j]));
                    continue;
                }
                if (key < 0) { o.Append(EncodeSegment(string.Join(",", l))); continue; }
                param = null;
            }
            if (param?.Value is { } v)
            {
                if (!query && v is "." or "..") return null;
                o.Append(EncodeSegment(v));
            }
            else if (key >= 0)
            {
                o.Length = key;
                dropped = true;
            }
        }
        // a `?` or `&` left with nothing after it (before any fragment)
        for (var i = 0; i < o.Length; i++)
        {
            if (o[i] is not ('?' or '&')) continue;
            if (i + 1 == o.Length || o[i + 1] == '#')
            {
                o.Remove(i, 1);
                break;
            }
        }
        return o.ToString();
    }

    /// <summary>
    /// A URL with query parameters set, as the runtime sets a paginated resource's page (<c>withParams</c>):
    /// each replaces the first parameter of its name (and drops the others), or is added at the end; the
    /// query is then written as a form (<c>URLSearchParams</c>).
    /// </summary>
    public static string WithParams(string url, IReadOnlyList<KeyValuePair<string, string>> ps)
    {
        if (ps.Count == 0) return url;
        string path = url, hash = "";
        var h = url.IndexOf('#');
        if (h >= 0)
        {
            path = url[..h];
            var rest = url[(h + 1)..];
            var h2 = rest.IndexOf('#');
            hash = h2 >= 0 ? rest[..h2] : rest;
        }
        var qi = path.IndexOf('?');
        var (b, query) = qi >= 0 ? (path[..qi], path[(qi + 1)..]) : (path, "");
        var q = ParseForm(query).ToList();
        foreach (var (k, v) in ps)
        {
            var at = q.FindIndex(x => x.Key == k);
            if (at < 0)
            {
                q.Add(new(k, v));
                continue;
            }
            q[at] = new(k, v);
            for (var j = q.Count - 1; j > at; j--)
                if (q[j].Key == k) q.RemoveAt(j);
        }
        var o = new StringBuilder(b).Append('?');
        for (var i = 0; i < q.Count; i++)
        {
            if (i > 0) o.Append('&');
            FormEncode(o, q[i].Key);
            o.Append('=');
            FormEncode(o, q[i].Value);
        }
        if (hash.Length > 0) o.Append('#').Append(hash);
        return o.ToString();
    }

    /// <summary>
    /// What <c>start-page</c> gives as a page, as the runtime's <c>toPage</c>: the whole number <c>parseInt</c>
    /// reads at the start of the value (<c>"3"</c>, <c>" 3x"</c>), else, or below 1, page 1.
    /// </summary>
    public static ulong ToPage(string? v)
    {
        var s = (v ?? "").AsSpan().TrimStart();
        if (s.StartsWith("+")) s = s[1..];
        if (s.StartsWith("-")) return 1;
        var n = 0;
        while (n < s.Length && char.IsAsciiDigit(s[n])) n++;
        if (n == 0) return 1;
        if (!ulong.TryParse(s[..n], NumberStyles.None, CultureInfo.InvariantCulture, out var page)) return ulong.MaxValue;
        return page == 0 ? 1 : page;
    }

    /// <summary>
    /// Every <c>&lt;</c> as a JSON unicode escape, so the data cannot close its <c>&lt;script&gt;</c> (or open a
    /// comment): the same JSON, since in valid JSON <c>&lt;</c> is only ever inside a string.
    /// </summary>
    public static byte[] Escape(ReadOnlySpan<byte> json)
    {
        var w = new ArrayBufferWriter<byte>(json.Length + 16);
        WriteEscaped(w, json);
        return w.WrittenSpan.ToArray();
    }

    internal static void WriteEscaped(IBufferWriter<byte> w, ReadOnlySpan<byte> json)
    {
        while (true)
        {
            var i = json.IndexOf((byte)'<');
            if (i < 0)
            {
                w.Write(json);
                return;
            }
            w.Write(json[..i]);
            w.Write("\\u003c"u8);
            json = json[(i + 1)..];
        }
    }

    /// <summary>One interpolated value, encoded: a whole <c>.</c> or <c>..</c> is encoded too, so it cannot be a dot segment.</summary>
    internal static string EncodeSegment(string v) => v is "." or ".." ? v.Replace(".", "%2E") : EncodeComponent(v);

    /// <summary><c>encodeURIComponent</c>: letters, digits and <c>-_.!~*'()</c> as they are, the rest as UTF-8 percent escapes.</summary>
    internal static string EncodeComponent(string v)
    {
        var plain = true;
        foreach (var c in v)
            if (!IsComponent(c)) { plain = false; break; }
        if (plain) return v;
        var o = new StringBuilder(v.Length * 3);
        Span<byte> buf = stackalloc byte[4];
        for (var i = 0; i < v.Length; i++)
        {
            var c = v[i];
            if (IsComponent(c)) { o.Append(c); continue; }
            Rune r;
            if (char.IsHighSurrogate(c) && i + 1 < v.Length && char.IsLowSurrogate(v[i + 1])) { r = new Rune(c, v[i + 1]); i++; }
            else if (char.IsSurrogate(c)) r = Rune.ReplacementChar;
            else r = new Rune(c);
            var n = r.EncodeToUtf8(buf);
            for (var j = 0; j < n; j++) Hex(o, buf[j]);
        }
        return o.ToString();
    }

    private static bool IsComponent(char c) => char.IsAsciiLetterOrDigit(c) || c is '-' or '_' or '.' or '!' or '~' or '*' or '\'' or '(' or ')';

    private static void Hex(StringBuilder o, byte b) => o.Append('%').Append("0123456789ABCDEF"[b >> 4]).Append("0123456789ABCDEF"[b & 15]);

    /// <summary><c>application/x-www-form-urlencoded</c>, as <c>URLSearchParams</c> writes it: letters, digits and <c>*-._</c> as they are, a space as <c>+</c>.</summary>
    private static void FormEncode(StringBuilder o, string v)
    {
        var bytes = Encoding.UTF8.GetBytes(v);
        foreach (var b in bytes)
        {
            if (b == ' ') o.Append('+');
            else if (b < 128 && (char.IsAsciiLetterOrDigit((char)b) || b is (byte)'*' or (byte)'-' or (byte)'.' or (byte)'_')) o.Append((char)b);
            else Hex(o, b);
        }
    }

    /// <summary>A query as a form: <c>+</c> is a space, percent escapes decoded (invalid UTF-8 replaced); empty pieces skipped.</summary>
    internal static IEnumerable<KeyValuePair<string, string>> ParseForm(string query)
    {
        if (query.StartsWith('?')) query = query[1..];
        foreach (var piece in query.Split('&'))
        {
            if (piece.Length == 0) continue;
            var eq = piece.IndexOf('=');
            var (k, v) = eq >= 0 ? (piece[..eq], piece[(eq + 1)..]) : (piece, "");
            yield return new(FormDecode(k), FormDecode(v));
        }
    }

    private static string FormDecode(string s)
    {
        if (s.AsSpan().IndexOfAny('+', '%') < 0) return s;
        var bytes = new List<byte>(s.Length);
        Span<byte> tmp = stackalloc byte[4];
        for (var i = 0; i < s.Length; i++)
        {
            var c = s[i];
            if (c == '+') bytes.Add((byte)' ');
            else if (c == '%' && i + 2 < s.Length + 0 && Uri.IsHexDigit(s[i + 1]) && Uri.IsHexDigit(s[i + 2]))
            {
                bytes.Add((byte)Convert.ToInt32(s.Substring(i + 1, 2), 16));
                i += 2;
            }
            else if (c < 128) bytes.Add((byte)c);
            else
            {
                Rune r;
                if (char.IsHighSurrogate(c) && i + 1 < s.Length && char.IsLowSurrogate(s[i + 1])) { r = new Rune(c, s[i + 1]); i++; }
                else if (char.IsSurrogate(c)) r = Rune.ReplacementChar;
                else r = new Rune(c);
                var n = r.EncodeToUtf8(tmp);
                for (var j = 0; j < n; j++) bytes.Add(tmp[j]);
            }
        }
        return Encoding.UTF8.GetString(bytes.ToArray());
    }

    /// <summary><c>[?&amp;]name=</c> at the end of <paramref name="o"/>: where the name starts, else -1.</summary>
    private static int TrailingKey(StringBuilder o)
    {
        if (o.Length == 0 || o[^1] != '=') return -1;
        var end = o.Length - 1;
        var start = -1;
        for (var i = end - 1; i >= 0; i--)
            if (o[i] is '?' or '&') { start = i; break; }
        if (start < 0) return -1;
        for (var i = start + 1; i < end; i++)
            if (o[i] is '=' or '#') return -1;
        return start + 1;
    }

    /// <summary>The non-empty segments of a path.</summary>
    internal ref struct Segments(ReadOnlySpan<char> path)
    {
        private ReadOnlySpan<char> _rest = path;

        public bool Next(out ReadOnlySpan<char> seg)
        {
            while (true)
            {
                if (_rest.IsEmpty) { seg = default; return false; }
                var i = _rest.IndexOf('/');
                if (i < 0) { seg = _rest; _rest = default; }
                else { seg = _rest[..i]; _rest = _rest[(i + 1)..]; }
                if (!seg.IsEmpty) return true;
            }
        }
    }
}
