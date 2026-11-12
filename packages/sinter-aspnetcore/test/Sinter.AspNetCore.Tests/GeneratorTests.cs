// [SinterEmbed]: sinter-axum's tests/macro.rs and tests/ui, for the source generator.
using System.Collections.Immutable;
using System.Text.Json.Serialization;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.TestHost;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.Diagnostics;
using Microsoft.CodeAnalysis.Text;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;
using Sinter.AspNetCore.Generator;
using Xunit;

namespace Sinter.AspNetCore.Tests;

public sealed record ArticleList(string[] Articles);

public sealed class ArticleStore
{
    public ArticleList All() => new(["from the store"]);
}

/// <summary>
/// The fixture build (fixtures/web, named by &lt;SinterBuild&gt; in the project file): `articles` has no request
/// the build describes, so without its resolver this would not compile.
/// </summary>
[SinterEmbed, SinterSkip("user")]
public static partial class FixtureWeb
{
    [SinterResolve("articles")]
    private static ArticleList? Articles(ArticleStore store, SlotRequest req) => req.Param("none") is null ? store.All() : null;
}

[JsonSerializable(typeof(ArticleList))]
internal sealed partial class TestJson : JsonSerializerContext;

public sealed class GeneratorTests
{
    [Fact]
    public async Task A_configuration_the_build_accepts_compiles_and_serves()
    {
        var b = WebApplication.CreateSlimBuilder(new WebApplicationOptions { ContentRootPath = AppContext.BaseDirectory });
        b.WebHost.UseTestServer();
        b.Logging.ClearProviders();
        b.Services.AddSingleton<ArticleStore>();
        b.Services.ConfigureHttpJsonOptions(o => o.SerializerOptions.TypeInfoResolverChain.Insert(0, TestJson.Default));
        b.Services.AddSinter(FixtureWeb.Build);
        await using var app = b.Build();
        app.UseSinter();
        app.MapGet("/api/tags", () => Results.Text("""{"tags":["a"]}""", "application/json"));
        await app.StartAsync();
        var html = await app.GetTestClient().GetStringAsync("/");
        Assert.Contains("""data-sn="0">{"tags":["a"]}</script>""", html);
        // the resolver's value, serialized as minimal APIs serialize it
        Assert.Contains("""data-sn="1">{"articles":["from the store"]}</script>""", html);
        Assert.Contains("""<script type="application/json" data-sn="2"></script>""", html);
        Assert.Equal("fixtures/web", FixtureWeb.Build.Dir);
    }

    [Fact]
    public async Task A_build_directory_from_another_build_is_refused()
    {
        var other = Harness.Build("other", """{ "version": 1, "pages": [] }""");
        var b = WebApplication.CreateSlimBuilder();
        b.WebHost.UseTestServer();
        b.Services.AddSinter(FixtureWeb.Build, o => o.Dir = other);
        await using var app = b.Build();
        var err = Assert.Throws<SinterException>(() => app.UseSinter()).Message;
        Assert.Contains("is not the build this assembly was compiled against", err);
    }

    [Fact]
    public void The_fingerprint_is_the_same_at_compile_time_and_at_startup()
    {
        foreach (var text in new[] { "{}", "\uFEFF{ \"a\": 1 }\r\n", "é😀" })
            Assert.Equal(SinterGenerator.Fingerprint(text), Manifest.ManifestReader.Fingerprint(text));
    }

    // compile errors: the generator run on a small compilation

    private const string Fixture = """
        { "version": 1, "pages": [ { "file": "index.html", "paths": ["/"], "data": [
          { "id": 0, "resource": "tags", "src": ["/api/tags"] },
          { "id": 1, "resource": "articles", "src": null, "when": true },
          { "id": 2, "resource": "user", "src": ["/api/user"] },
          { "id": 3, "resource": "feed", "src": ["/api/feed?tag=", { "url": "tag" }], "when": { "and": [{ "url": "tag" }, { "not": { "url": "x", "eq": "y" } }] },
            "query": [["page", "1"]], "start": { "url": "page", "key": "page", "size": 10, "query": [["page", "2"]] } } ] } ],
          "routes": [ { "from": "/a.html", "to": "/a/", "status": 301 } ], "locales": { "base": "en", "list": ["en", "de"] } }
        """;

    private static (ImmutableArray<Diagnostic> Generator, ImmutableArray<Diagnostic> Compiled, string? Source) Run(string code, string? manifest = Fixture, string? build = "../web/dist")
    {
        var dir = Path.Combine(Path.GetTempPath(), "sinter-gen", "web", "dist");
        var refs = AppDomain.CurrentDomain.GetAssemblies()
            .Where(a => !a.IsDynamic && a.Location.Length > 0)
            .Select(a => MetadataReference.CreateFromFile(a.Location))
            .Append(MetadataReference.CreateFromFile(typeof(SinterEmbedAttribute).Assembly.Location));
        var compilation = CSharpCompilation.Create("t",
            [CSharpSyntaxTree.ParseText(Prefix + code, path: "Web.cs")],
            refs, new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary, nullableContextOptions: NullableContextOptions.Enable));
        var texts = manifest is null ? [] : ImmutableArray.Create<AdditionalText>(new Text(Path.Combine(dir, "sinter-embed.json"), manifest));
        var options = new Options(build is null ? [] : new Dictionary<string, string> { ["build_property.SinterBuild"] = build, ["build_property.SinterBuildDir"] = dir });
        var driver = CSharpGeneratorDriver.Create([new SinterGenerator().AsSourceGenerator()], texts, optionsProvider: options);
        driver.RunGeneratorsAndUpdateCompilation(compilation, out var output, out var diagnostics);
        var source = output.SyntaxTrees.Skip(1).FirstOrDefault()?.ToString();
        return (diagnostics, output.GetDiagnostics().Where(d => d.Severity == DiagnosticSeverity.Error).ToImmutableArray(), source);
    }

    [Fact]
    public void The_generated_code_compiles()
    {
        var (gen, compiled, source) = Run("""
            [SinterEmbed, SinterSkip("user")]
            public partial class Web
            {
                [SinterResolve("articles")] static Task<string?> A(SlotRequest r, System.Threading.CancellationToken ct) => Task.FromResult<string?>("[]");
            }
            namespace N { public static partial class Outer { [SinterEmbed, SinterSkip("index.html:user", "articles")] private partial record Inner; } }
            """);
        Assert.Empty(gen);
        Assert.Empty(compiled);
        Assert.Contains("Cond.And(global::Sinter.AspNetCore.Manifest.Cond.Url(\"tag\", null, null), global::Sinter.AspNetCore.Manifest.Cond.Not(", source);
        Assert.Contains("o.Skip(\"user\");", source);
        Assert.Contains("new global::Sinter.AspNetCore.Manifest.ManifestLocales(\"en\", new string[] { \"en\", \"de\" }, \"/\")", source);
    }

    [Fact]
    public void A_placeholder_without_a_source_is_a_compile_error()
    {
        const string code = """[SinterEmbed, SinterSkip("user")] partial class Web { }""";
        var (gen, _, _) = Run(code);
        var d = Assert.Single(gen);
        Assert.Equal("SINTER003", d.Id);
        Assert.Equal(
            "index.html: `articles`: the build could not describe its request (its `src` or `start-page` calls a helper, or reads something other than `$url`). Add [SinterResolve(\"articles\")] to a method that gives its data, or [SinterSkip(\"articles\")] to leave it to the browser.",
            d.GetMessage());
        Assert.Equal("Web", SourceAt(d, code));
    }

    [Fact]
    public void A_name_no_placeholder_has_is_a_compile_error()
    {
        const string code = """[SinterEmbed, SinterSkip("articles", "usr")] partial class Web { }""";
        var (gen, _, _) = Run(code);
        var d = Assert.Single(gen);
        Assert.Equal("SINTER004", d.Id);
        Assert.Equal("no page of the build has a placeholder for `usr` (it has `articles`, `feed`, `tags`, `user`)", d.GetMessage());
        Assert.Equal("\"usr\"", SourceAt(d, code));
    }

    [Fact]
    public void The_build_not_there_is_a_compile_error()
    {
        var (gen, _, _) = Run("""[SinterEmbed] partial class Web { }""", manifest: null);
        Assert.Contains("sinter-embed.json: not found. Build the frontend first, with `sinter({ embed: true })`", Assert.Single(gen).GetMessage());
        (gen, _, _) = Run("""[SinterEmbed] partial class Web { }""", manifest: null, build: null);
        Assert.Contains("add <SinterBuild>../web/dist</SinterBuild>", Assert.Single(gen).GetMessage());
        (gen, _, _) = Run("""[SinterEmbed] partial class Web { }""", manifest: """{ "version": 2 }""");
        Assert.Equal("SINTER002", Assert.Single(gen).Id);
    }

    [Fact]
    public void Resolvers_are_checked()
    {
        var (gen, _, _) = Run("""
            [SinterEmbed, SinterSkip("user")]
            partial class Web
            {
                [SinterResolve("articles")] Task<byte[]?> A() => Task.FromResult<byte[]?>(null);
                [SinterResolve("tags")] static Task T() => Task.CompletedTask;
            }
            class Plain { }
            [SinterEmbed] class NotPartial { }
            """);
        Assert.Equal(["SINTER005", "SINTER006", "SINTER007"], gen.Select(d => d.Id).Order());
    }

    private const string Prefix = "using Sinter.AspNetCore; using System.Threading.Tasks;\n";

    /// <summary>The source a diagnostic points at (its location names the file and the span).</summary>
    private static string SourceAt(Diagnostic d, string code)
    {
        Assert.Equal("Web.cs", d.Location.GetLineSpan().Path);
        return (Prefix + code).Substring(d.Location.SourceSpan.Start, d.Location.SourceSpan.Length);
    }

    private sealed class Text(string path, string text) : AdditionalText
    {
        public override string Path { get; } = path;
        public override SourceText GetText(CancellationToken cancellationToken = default) => SourceText.From(text);
    }

    private sealed class Options(Dictionary<string, string> global) : AnalyzerConfigOptionsProvider
    {
        public override AnalyzerConfigOptions GlobalOptions { get; } = new Opts(global);
        public override AnalyzerConfigOptions GetOptions(SyntaxTree tree) => new Opts([]);
        public override AnalyzerConfigOptions GetOptions(AdditionalText textFile) => new Opts([]);
    }

    private sealed class Opts(Dictionary<string, string> values) : AnalyzerConfigOptions
    {
        public override bool TryGetValue(string key, out string value) => values.TryGetValue(key, out value!);
    }
}
