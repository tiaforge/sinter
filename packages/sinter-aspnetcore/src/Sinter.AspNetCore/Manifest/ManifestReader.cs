// Reads sinter-embed.json at startup when the manifest is not compiled in ([SinterEmbed] compiles it in).
// JsonDocument only: no reflection, so this is NativeAOT-safe.
using System.Text.Json;

namespace Sinter.AspNetCore.Manifest;

internal static class ManifestReader
{
    public const string File = "sinter-embed.json";

    public static SinterManifest Parse(string text)
    {
        using var doc = JsonDocument.Parse(text, new JsonDocumentOptions { AllowTrailingCommas = false });
        var root = doc.RootElement;
        var version = root.TryGetProperty("version", out var v) && v.ValueKind == JsonValueKind.Number ? v.GetInt32() : 0;
        if (version != 1) throw new SinterException($"version {version} (this package reads version 1)");
        var pages = Array(root, "pages", required: true).Select(Page).ToArray();
        var routes = Array(root, "routes", required: false).Select(Route).ToArray();
        ManifestLocales? locales = null;
        if (root.TryGetProperty("locales", out var l) && l.ValueKind == JsonValueKind.Object)
            locales = new ManifestLocales(Str(l, "base"), Array(l, "list", true).Select(x => x.GetString()!).ToArray(), OptStr(l, "at") ?? "/");
        return new SinterManifest(pages, routes, locales);
    }

    /// <summary>
    /// FNV-1a (64 bits) over the manifest's text: what the generator compiles in, so that startup can
    /// refuse a build directory from another build without parsing it. The generator computes the same.
    /// </summary>
    public static ulong Fingerprint(string text)
    {
        var h = 14695981039346656037UL;
        foreach (var c in text.AsSpan().TrimStart('\uFEFF'))
        {
            if (c == '\r') continue;
            h = (h ^ c) * 1099511628211UL;
        }
        return h;
    }

    private static ManifestPage Page(JsonElement p) =>
        new(Str(p, "file"), Array(p, "paths", true).Select(x => x.GetString()!).ToArray(), Array(p, "data", true).Select(Slot).ToArray());

    private static ManifestSlot Slot(JsonElement d)
    {
        UrlPart[]? src = null;
        if (d.TryGetProperty("src", out var s) && s.ValueKind == JsonValueKind.Array) src = s.EnumerateArray().Select(Part).ToArray();
        var (inBrowser, when) = (false, (Cond?)null);
        if (d.TryGetProperty("when", out var w))
        {
            if (w.ValueKind == JsonValueKind.True) inBrowser = true;
            else if (w.ValueKind == JsonValueKind.Object) when = Condition(w);
        }
        ManifestStart? start = null;
        if (d.TryGetProperty("start", out var st) && st.ValueKind == JsonValueKind.Object)
            start = new ManifestStart(Str(st, "url"), Str(st, "key"), st.GetProperty("size").GetUInt64(),
                st.TryGetProperty("skip", out var sk) && sk.ValueKind == JsonValueKind.True, Pairs(st, "query"));
        return new ManifestSlot(d.GetProperty("id").GetInt32(), Str(d, "resource"), src, inBrowser, when, Pairs(d, "query"), start);
    }

    private static UrlPart Part(JsonElement e) =>
        e.ValueKind == JsonValueKind.String ? UrlPart.Lit(e.GetString()!) : UrlPart.Url(Str(e, "url"));

    private static Cond Condition(JsonElement c)
    {
        if (c.TryGetProperty("not", out var n)) return Cond.Not(Condition(n));
        if (c.TryGetProperty("and", out var a)) return Cond.And(a.EnumerateArray().Select(Condition).ToArray());
        if (c.TryGetProperty("or", out var o)) return Cond.Or(o.EnumerateArray().Select(Condition).ToArray());
        return Cond.Url(Str(c, "url"), OptStr(c, "eq"), OptStr(c, "ne"));
    }

    private static ManifestRoute Route(JsonElement r) =>
        new(Str(r, "from"), Str(r, "to"), r.GetProperty("status").GetInt32(), OptStr(r, "file"),
            r.TryGetProperty("choose", out var c) && c.ValueKind == JsonValueKind.True);

    private static KeyValuePair<string, string>[] Pairs(JsonElement e, string name) =>
        Array(e, name, false).Select(p => new KeyValuePair<string, string>(p[0].GetString()!, p[1].GetString()!)).ToArray();

    private static IEnumerable<JsonElement> Array(JsonElement e, string name, bool required)
    {
        if (e.TryGetProperty(name, out var a) && a.ValueKind == JsonValueKind.Array) return a.EnumerateArray().ToArray();
        if (required) throw new SinterException($"no `{name}`");
        return [];
    }

    private static string Str(JsonElement e, string name) =>
        e.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.String ? v.GetString()! : throw new SinterException($"no `{name}`");

    private static string? OptStr(JsonElement e, string name) =>
        e.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.String ? v.GetString() : null;
}
