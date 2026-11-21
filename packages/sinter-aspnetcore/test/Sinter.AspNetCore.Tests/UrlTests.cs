// SinterUrl's own API. The URL rules themselves run on the cases src/server.ts and sinter-axum run too
// (ServerCasesTests.cs).
using Xunit;

namespace Sinter.AspNetCore.Tests;

public sealed class UrlTests
{
    [Fact]
    public void A_param_is_one_value_or_a_list()
    {
        var u = SinterUrl.UrlParams("/", "?tag=a&q=1&tag=b+c", [], ["tag"]);
        Assert.True(u["tag"].IsList);
        Assert.Equal(new[] { "a", "b c" }, u["tag"].Values);
        Assert.Null(u["tag"].Value);
        Assert.Equal("a,b c", u["tag"].ToString());
        Assert.False(u["q"].IsList);
        Assert.Equal(new[] { "1" }, u["q"].Values);
    }

    [Fact]
    public void With_no_parameters_the_url_is_as_it_was()
    {
        // (no layer sets none: a placeholder without `query` is not given to withParams in src/server.ts)
        Assert.Equal("/api/m?tag=a%20b", SinterUrl.WithParams("/api/m?tag=a%20b", []));
    }

    [Fact]
    public void A_page_past_ulong_is_the_largest() => Assert.Equal(ulong.MaxValue, SinterUrl.ToPage("99999999999999999999999"));
}
