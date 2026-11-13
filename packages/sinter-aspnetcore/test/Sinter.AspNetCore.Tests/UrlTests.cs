// sinter-axum's src/url.rs tests: the same requests as the browser runtime makes.
using Sinter.AspNetCore.Manifest;
using Xunit;

namespace Sinter.AspNetCore.Tests;

public sealed class UrlTests
{
    private static UrlPart L(string s) => UrlPart.Lit(s);
    private static UrlPart V(string s) => UrlPart.Url(s);
    private static Dictionary<string, UrlParam> P(params (string, string)[] kv) => kv.ToDictionary(x => x.Item1, x => UrlParam.One(x.Item2));
    private static KeyValuePair<string, string>[] Q(params (string, string)[] kv) => kv.Select(x => new KeyValuePair<string, string>(x.Item1, x.Item2)).ToArray();

    [Fact]
    public void Params_from_query_and_path()
    {
        string[] pats = ["/", "/article/:slug"];
        // ASP.NET Core gives the path decoded (an encoded `/` stays %2F)
        var u = SinterUrl.UrlParams("/article/a b", "?x=1&x=2&q=a+b&constructor=1", pats);
        Assert.Equal("a b", u["slug"].Value);
        Assert.Equal("2", u["x"].Value);
        Assert.Equal("a b", u["q"].Value);
        Assert.False(u.ContainsKey("constructor"));
        Assert.Equal("a/b", SinterUrl.UrlParams("/article/a%2Fb", null, pats)["slug"].Value);
        // a path segment wins over a query parameter of the same name
        Assert.Equal("s", SinterUrl.UrlParams("/article/s", "slug=q", pats)["slug"].Value);
        Assert.Empty(SinterUrl.UrlParams("/other/s", null, pats));
    }

    [Fact]
    public void Array_parameters_are_lists()
    {
        var u = SinterUrl.UrlParams("/", "?tag=a&q=1&tag=b+c", [], ["tag", "f"]);
        Assert.True(u["tag"].IsList);
        Assert.Equal(new[] { "a", "b c" }, u["tag"].Values);
        Assert.Null(u["tag"].Value);
        Assert.Empty(u["f"].Values);
        Assert.Equal(new[] { "1" }, u["q"].Values);
        // a whole query value: a repeated key; an empty list leaves it out; elsewhere joined with `,`; refused in a path
        Assert.Equal("/api/a?tag=a&tag=b%20c&n=1", SinterUrl.Expand([L("/api/a?tag="), V("tag"), L("&f="), V("f"), L("&n=1")], u));
        Assert.Equal("/api/a?x=t-a%2Cb%20c", SinterUrl.Expand([L("/api/a?x=t-"), V("tag")], u));
        Assert.Null(SinterUrl.Expand([L("/api/"), V("tag")], u));
    }

    [Fact]
    public void Expand_as_the_runtime()
    {
        UrlPart[] t = [L("/api/articles?tag="), V("tag"), L("&limit=10")];
        Assert.Equal("/api/articles?tag=a%26b&limit=10", SinterUrl.Expand(t, P(("tag", "a&b"))));
        // absent: the parameter and its separator go
        Assert.Equal("/api/articles?limit=10", SinterUrl.Expand(t, P()));
        Assert.Equal("/api/x?a=1", SinterUrl.Expand([L("/api/x?a=1&b="), V("b")], P()));
        Assert.Equal("/api/x", SinterUrl.Expand([L("/api/x?b="), V("b")], P()));
        // path values: encoded, a dot segment refused
        t = [L("/api/articles/"), V("slug"), L("/comments")];
        Assert.Equal("/api/articles/%C3%A9%2Fx/comments", SinterUrl.Expand(t, P(("slug", "é/x"))));
        Assert.Null(SinterUrl.Expand(t, P(("slug", ".."))));
        Assert.Equal("/api/articles//comments", SinterUrl.Expand(t, P()));
        Assert.Equal("a'b(c)*!~", SinterUrl.EncodeSegment("a'b(c)*!~"));
        Assert.Equal("%F0%9F%98%80", SinterUrl.EncodeComponent("😀"));
    }

    [Theory]
    [InlineData("3", 3ul), InlineData(" 3x", 3ul), InlineData("+2", 2ul), InlineData("0", 1ul), InlineData("-4", 1ul)]
    [InlineData("abc", 1ul), InlineData("", 1ul), InlineData(null, 1ul), InlineData("2.9", 2ul), InlineData("99999999999999999999999", ulong.MaxValue)]
    public void To_page_as_parse_int(string? v, ulong n) => Assert.Equal(n, SinterUrl.ToPage(v));

    [Fact]
    public void With_params_as_the_runtime()
    {
        // added in order; the query written as a form (a space as `+`)
        Assert.Equal("/api/m?page=1&limit=10", SinterUrl.WithParams("/api/m", Q(("page", "1"), ("limit", "10"))));
        Assert.Equal("/api/m?tag=a+b&limit=10", SinterUrl.WithParams("/api/m?tag=a%20b", Q(("limit", "10"))));
        // a parameter of the same name: replaced where it was, its repeats dropped
        Assert.Equal("/api/m?limit=10&x=1", SinterUrl.WithParams("/api/m?limit=5&x=1&limit=6", Q(("limit", "10"))));
        Assert.Equal("/api/m?n=1#top", SinterUrl.WithParams("/api/m#top", Q(("n", "1"))));
        Assert.Equal("/api/m?x=1", SinterUrl.WithParams("/api/m?x=1", Q()));
        // the form's own encoding, as URLSearchParams writes it
        Assert.Equal("/api/m?q=%C3%A9*%7E%27%28%29%21&n=1", SinterUrl.WithParams("/api/m?q=é*~'()!", Q(("n", "1"))));
    }

    [Fact]
    public void Escape_writes_lt_as_a_json_escape()
    {
        Assert.Equal("{\"a\":\"\\u003c/script>\"}", System.Text.Encoding.UTF8.GetString(SinterUrl.Escape("{\"a\":\"</script>\"}"u8)));
        Assert.Equal("{}", System.Text.Encoding.UTF8.GetString(SinterUrl.Escape("{}"u8)));
    }

    [Fact]
    public void Paths_match_in_the_manifests_order()
    {
        var t = new PathTable();
        t.Add(0, "/article/:slug", exact: false);
        t.Add(1, "/article/new", exact: false);
        t.Add(2, "/about/", exact: false);
        t.Add(3, "/x.html", exact: true);
        Assert.Equal(0, t.Find("/article/new"));
        Assert.Equal(2, t.Find("/about"));
        Assert.Equal(2, t.Find("//about/"));
        Assert.Equal(3, t.Find("/x.html"));
        Assert.Equal(-1, t.Find("/x.html/"));
        Assert.Equal(-1, t.Find("/article"));
    }
}
