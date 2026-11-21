// Choosing a visitor's language: the cases src/locales.ts, the chooser page's script and sinter-axum run
// (test/fixtures/choose-cases.json at the repository's root).
using System.Text.Json;
using Xunit;

namespace Sinter.AspNetCore.Tests;

public sealed class ChooseTests
{
    private sealed record Case(string Base, string[] List, string[] Tags, string Want, Dictionary<string, string[]>? Codes);
    private sealed record Cases(Case[] cases);

    [Fact]
    public void The_shared_cases()
    {
        var dir = new DirectoryInfo(AppContext.BaseDirectory);
        while (dir is not null && !File.Exists(Path.Combine(dir.FullName, "test", "fixtures", "choose-cases.json"))) dir = dir.Parent;
        Assert.NotNull(dir);
        var json = File.ReadAllText(Path.Combine(dir!.FullName, "test", "fixtures", "choose-cases.json"));
        var cases = JsonSerializer.Deserialize<Cases>(json, new JsonSerializerOptions { PropertyNameCaseInsensitive = true })!;
        Assert.NotEmpty(cases.cases);
        foreach (var c in cases.cases)
            Assert.True(SinterMiddleware.ChooseLanguage(c.List, c.Base, c.Tags, c.Codes) == c.Want, $"{string.Join(",", c.List)} {string.Join(",", c.Tags)}: want {c.Want}");
    }
}
