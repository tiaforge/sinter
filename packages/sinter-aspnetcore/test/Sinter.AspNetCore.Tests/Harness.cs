using System.Net;
using System.Security.Claims;
using System.Text.Encodings.Web;
using Microsoft.AspNetCore.Authentication;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.Routing;
using Microsoft.AspNetCore.TestHost;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;

namespace Sinter.AspNetCore.Tests;

public enum Api { Minimal, Mvc }

/// <summary>A small build in a temporary directory, and an app over it with the test API (minimal or MVC).</summary>
public static class Harness
{
    public const string Head = """<!DOCTYPE html><html><head><link rel="stylesheet" href="/assets/app.css">""";
    private static int _n;

    public static string Build(string name, string manifest, params (string File, string Html)[] pages)
    {
        var dir = Path.Combine(Path.GetTempPath(), $"sinter-aspnetcore-{Environment.ProcessId}-{name}-{Interlocked.Increment(ref _n)}");
        Directory.CreateDirectory(dir);
        File.WriteAllText(Path.Combine(dir, "sinter-embed.json"), manifest);
        foreach (var (f, html) in pages)
        {
            Directory.CreateDirectory(Path.GetDirectoryName(Path.Combine(dir, f))!);
            File.WriteAllText(Path.Combine(dir, f), html);
        }
        return dir;
    }

    /// <summary>RealWorld's shape: a list and its tags on `/`, an article and its comments.</summary>
    public static string AppBuild() => Build("app", """
        { "version": 1, "pages": [
          { "file": "index.html", "paths": ["/", "/index.html"], "data": [
            { "id": 3, "resource": "articles", "src": ["/api/articles?tag=", { "url": "tag" }, "&limit=10"] },
            { "id": 4, "resource": "tags", "src": ["/api/tags"] },
            { "id": 5, "resource": "feed", "src": ["/api/feed"], "when": true } ] },
          { "file": "article.html", "paths": ["/article/:slug"], "data": [
            { "id": 0, "resource": "article", "src": ["/api/articles/", { "url": "slug" }] },
            { "id": 1, "resource": "comments", "src": ["/api/articles/", { "url": "slug" }, "/comments"] } ] } ] }
        """,
        ("index.html", Head + """<script type="application/json" data-sn="3"></script><script type="application/json" data-sn="4"></script><script type="application/json" data-sn="5"></script></head><body><main></main></body></html>"""),
        ("article.html", Head + """<script type="application/json" data-sn="0"></script><script type="application/json" data-sn="1"></script></head><body></body></html>"""));

    public static string ArticlesJson(HttpContext ctx)
    {
        var who = ctx.Request.Headers.Cookie.ToString() is { Length: > 0 } c ? c : "-";
        return $$"""{"articles":[{"title":"</script><b>x"}],"q":"{{ctx.Request.QueryString.Value?.TrimStart('?')}}","who":"{{who}}"}""";
    }

    /// <summary>
    /// The app: the middleware first, then a stand-in for the static files (what no endpoint answers), then
    /// the API's endpoints. <paramref name="configure"/> sets the options; <paramref name="services"/> and
    /// <paramref name="map"/> add to the app.
    /// </summary>
    public static async Task<WebApplication> App(
        Api api,
        Action<SinterOptions> configure,
        Action<IServiceCollection>? services = null,
        Action<WebApplication>? map = null,
        Func<HttpContext, string>? fallback = null,
        bool upstreamServer = false)
    {
        var b = WebApplication.CreateSlimBuilder();
        if (!upstreamServer) b.WebHost.UseTestServer();
        else b.WebHost.UseUrls("http://127.0.0.1:0");
        b.Logging.ClearProviders();
        if (api == Api.Mvc) b.Services.AddControllers().AddApplicationPart(typeof(ArticlesController).Assembly);
        b.Services.AddSinter(configure);
        services?.Invoke(b.Services);
        var app = b.Build();
        app.UseSinter();
        // what ServeDir is in the axum tests: anything no endpoint answers
        app.Use((ctx, next) => ctx.GetEndpoint() is null
            ? ctx.Response.WriteAsync(fallback?.Invoke(ctx) ?? "static file")
            : next(ctx));
        if (api == Api.Mvc) app.MapControllers();
        else MapMinimal(app);
        map?.Invoke(app);
        await app.StartAsync();
        return app;
    }

    public static void MapMinimal(IEndpointRouteBuilder app)
    {
        app.MapGet("/api/articles", (HttpContext ctx) => Results.Text(ArticlesJson(ctx), "application/json"));
        app.MapGet("/api/tags", () => Results.Text("""{"tags":["a"]}""", "application/json"));
        // echoes the static header of an API (`sinter({ apis: { … headers } })`)
        app.MapGet("/api/version", (HttpContext ctx) => Results.Text($$"""{"x":"{{ctx.Request.Headers["X-Api"]}}"}""", "application/json"));
        app.MapGet("/api/articles/{slug}", (string slug) => Results.Text($$$"""{"article":{"slug":"{{{slug}}}"}}""", "application/json"));
        app.MapGet("/api/articles/{slug}/comments", () => Results.Text("no", statusCode: 500));
    }

    public static Request Get(string uri) => new(HttpMethod.Get, uri);

    public sealed record Request(HttpMethod Method, string Uri)
    {
        public List<(string, string)> Headers { get; } = [];
        public Request With(string name, string value) { Headers.Add((name, value)); return this; }
    }

    public static async Task<(HttpStatusCode Status, HttpResponseMessage Response, string Body)> Send(WebApplication app, Request r)
    {
        var client = app.GetTestClient();
        var m = new HttpRequestMessage(r.Method, r.Uri);
        foreach (var (k, v) in r.Headers) m.Headers.TryAddWithoutValidation(k, v);
        var res = await client.SendAsync(m);
        return (res.StatusCode, res, await res.Content.ReadAsStringAsync());
    }

    public static async Task<string> Html(WebApplication app, string uri) => (await Send(app, Get(uri))).Body;
}

[ApiController]
public sealed class ArticlesController : ControllerBase
{
    [HttpGet("/api/articles")]
    public ContentResult List() => Content(Harness.ArticlesJson(HttpContext), "application/json");

    [HttpGet("/api/tags")]
    public ContentResult Tags() => Content("""{"tags":["a"]}""", "application/json");

    [HttpGet("/api/version")]
    public ContentResult Version() => Content($$"""{"x":"{{HttpContext.Request.Headers["X-Api"]}}"}""", "application/json");

    [HttpGet("/api/articles/{slug}")]
    public ContentResult One(string slug) => Content($$$"""{"article":{"slug":"{{{slug}}}"}}""", "application/json");

    [HttpGet("/api/articles/{slug}/comments")]
    public IActionResult Comments() => StatusCode(500, "no");
}

/// <summary>Signed in when the request has the cookie `user=…`.</summary>
public sealed class CookieUser(IOptionsMonitor<AuthenticationSchemeOptions> o, ILoggerFactory l, UrlEncoder e) : AuthenticationHandler<AuthenticationSchemeOptions>(o, l, e)
{
    protected override Task<AuthenticateResult> HandleAuthenticateAsync()
    {
        var user = Request.Cookies["user"];
        if (user is null) return Task.FromResult(AuthenticateResult.NoResult());
        var id = new ClaimsIdentity([new Claim(ClaimTypes.Name, user)], Scheme.Name);
        return Task.FromResult(AuthenticateResult.Success(new AuthenticationTicket(new ClaimsPrincipal(id), Scheme.Name)));
    }
}

[ApiController]
public sealed class MeController : ControllerBase
{
    [Authorize, HttpGet("/api/me")]
    public ContentResult Me() => Content($$"""{"name":"{{User.Identity!.Name}}"}""", "application/json");
}
