// The URL rules on the cases src/server.ts and sinter-axum run too (test/fixtures/server-cases.json at the
// repository's root).
using System.Text;
using System.Text.Json;
using Microsoft.AspNetCore.Http;
using Sinter.AspNetCore.Manifest;
using Xunit;

namespace Sinter.AspNetCore.Tests;

public sealed class ServerCasesTests
{
    private static readonly JsonElement Cases = Load();

    private static JsonElement Load()
    {
        var dir = new DirectoryInfo(AppContext.BaseDirectory);
        while (dir is not null && !File.Exists(Path.Combine(dir.FullName, "test", "fixtures", "server-cases.json"))) dir = dir.Parent;
        Assert.NotNull(dir);
        using var doc = JsonDocument.Parse(File.ReadAllText(Path.Combine(dir!.FullName, "test", "fixtures", "server-cases.json")));
        return doc.RootElement.Clone();
    }

    private static IEnumerable<JsonElement> Section(string name)
    {
        var all = Cases.GetProperty(name).EnumerateArray().ToArray();
        Assert.NotEmpty(all);
        return all;
    }

    private static string[] Strings(JsonElement e) => e.EnumerateArray().Select(x => x.GetString()!).ToArray();

    private static Dictionary<string, UrlParam> Params(JsonElement e) =>
        e.EnumerateObject().ToDictionary(x => x.Name, x => x.Value.ValueKind == JsonValueKind.Array ? UrlParam.List(Strings(x.Value)) : UrlParam.One(x.Value.GetString()!));

    /// <summary>A parameter as the case writes it: its string, or its list as JSON.</summary>
    private static string Show(UrlParam p) => p.IsList ? JsonSerializer.Serialize(p.Values) : p.Value!;

    private static string? Want(JsonElement c) => c.GetProperty("want").ValueKind == JsonValueKind.Null ? null : c.GetProperty("want").GetString();

    /// <summary>The request the build describes for a placeholder of the manifest, as the case writes it (without the <c>id</c> and <c>resource</c> every one has).</summary>
    private static string? Described(string placeholder, JsonElement ps)
    {
        var m = ManifestReader.Parse($$"""{ "version": 2, "pages": [ { "file": "x.html", "paths": [], "data": [ { "id": 0, "resource": "r", {{placeholder.Trim()[1..]}} ] } ] }""");
        return SinterEngine.DescribedUrl(m.Pages[0].Data[0], Params(ps));
    }

    [Fact]
    public void Params_from_the_path_and_the_query()
    {
        foreach (var c in Section("params"))
        {
            // ASP.NET Core gives the path decoded (but an encoded `/`), and the query as sent with its `?`
            var path = PathString.FromUriComponent(c.GetProperty("path").GetString()!).Value!;
            var query = c.TryGetProperty("query", out var q) ? "?" + q.GetString() : null;
            var arrays = c.TryGetProperty("arrays", out var a) ? Strings(a) : null;
            var got = SinterUrl.UrlParams(path, query, Strings(c.GetProperty("patterns")), arrays);
            var want = Params(c.GetProperty("want"));
            Assert.True(want.Count == got.Count && want.All(x => got.TryGetValue(x.Key, out var g) && Show(g) == Show(x.Value)),
                $"{c}: got {string.Join(", ", got.Select(x => $"{x.Key}={Show(x.Value)}"))}");
        }
    }

    [Fact]
    public void Expand_fills_a_template()
    {
        foreach (var c in Section("expand"))
        {
            var src = c.GetProperty("src").EnumerateArray().Select(x => x.ValueKind == JsonValueKind.String ? UrlPart.Lit(x.GetString()!) : UrlPart.Url(x.GetProperty("url").GetString()!)).ToArray();
            Assert.True(SinterUrl.Expand(src, Params(c.GetProperty("params"))) == Want(c), c.ToString());
        }
    }

    [Fact]
    public void With_params_sets_query_parameters()
    {
        foreach (var c in Section("withParams"))
        {
            var set = c.GetProperty("set").EnumerateArray().Select(x => new KeyValuePair<string, string>(x[0].GetString()!, x[1].GetString()!)).ToArray();
            Assert.True(SinterUrl.WithParams(c.GetProperty("url").GetString()!, set) == Want(c), c.ToString());
        }
    }

    [Fact]
    public void The_described_request()
    {
        foreach (var c in Section("described"))
            Assert.True(Described(c.GetProperty("placeholder").GetRawText(), c.GetProperty("params")) == Want(c), c.ToString());
    }

    [Fact]
    public void When_holds()
    {
        foreach (var c in Section("when"))
        {
            var got = Described($$"""{ "src": ["/x"], "when": {{c.GetProperty("when").GetRawText()}} }""", c.GetProperty("params")) is not null;
            Assert.True(got == c.GetProperty("holds").GetBoolean(), c.ToString());
        }
    }

    [Fact]
    public void The_first_rule_for_a_path()
    {
        foreach (var c in Section("match"))
        {
            var t = new PathTable();
            var i = 0;
            foreach (var r in c.GetProperty("rules").EnumerateArray())
                t.Add(i++, r.GetProperty("pattern").GetString()!, exact: r.TryGetProperty("exact", out var x) && x.GetBoolean());
            foreach (var p in c.GetProperty("paths").EnumerateArray())
            {
                var want = p[1].ValueKind == JsonValueKind.Null ? -1 : p[1].GetInt32();
                Assert.True(t.Find(p[0].GetString()!) == want, $"{p}: got {t.Find(p[0].GetString()!)}");
            }
        }
    }

    [Fact]
    public void Escape_writes_lt_as_a_json_escape()
    {
        foreach (var c in Section("escape"))
            Assert.Equal(Want(c), Encoding.UTF8.GetString(SinterUrl.Escape(Encoding.UTF8.GetBytes(c.GetProperty("json").GetString()!))));
    }
}
