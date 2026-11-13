// sinter-axum's tests/embed.rs, for ASP.NET Core: each against minimal APIs and MVC controllers.
using System.Diagnostics;
using System.Net;
using System.Text;
using Microsoft.AspNetCore.Authentication;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.TestHost;
using Microsoft.Extensions.DependencyInjection;
using Xunit;
using static Sinter.AspNetCore.Tests.Harness;

namespace Sinter.AspNetCore.Tests;

public sealed class EmbedTests
{
    /// <summary>`‹` stands for the JSON escape the middleware writes for `<`.</summary>
    private static string E(string s) => s.Replace("‹", "\\u003c");

    public static TheoryData<Api> Apis => [Api.Minimal, Api.Mvc];

    [Theory, MemberData(nameof(Apis))]
    public async Task Fills_each_placeholder_from_the_api_in_process(Api api)
    {
        await using var a = await App(api, o => { o.Dir = AppBuild(); o.Skip("feed"); });
        var (status, res, html) = await Send(a, Get("/?tag=rust%20lang&x=1").With("Cookie", "s=1"));
        Assert.Equal(HttpStatusCode.OK, status);
        Assert.Equal("text/html; charset=utf-8", res.Content.Headers.ContentType!.ToString());
        Assert.Equal("private, no-cache", res.Headers.NonValidated["Cache-Control"].ToString());
        // `$url.tag` into the template, encoded as the browser would; the cookie forwarded; `<` escaped
        Assert.Contains(E("""<script type="application/json" data-sn="3">{"articles":[{"title":"‹/script>‹b>x"}],"q":"tag=rust%20lang&limit=10","who":"s=1"}</script>"""), html);
        Assert.Contains("""<script type="application/json" data-sn="4">{"tags":["a"]}</script>""", html);
        // a `when`: left to the browser
        Assert.Contains("""<script type="application/json" data-sn="5"></script>""", html);
        Assert.StartsWith(Head, html);
        Assert.EndsWith("<main></main></body></html>", html);
        // no tag: the parameter is left out
        Assert.Contains("\"q\":\"limit=10\"", await Html(a, "/"));
        // path parameters; a failing request (the comments answer 500) ends the page with the error text
        (status, _, html) = await Send(a, Get("/article/hello%20world"));
        Assert.Equal(HttpStatusCode.OK, status);
        Assert.Contains("""data-sn="0">{"article":{"slug":"hello world"}}</script>""", html);
        Assert.EndsWith("""<script type="application/json" data-sn="1"></script></head><body data-sn-failed><p>Error, please retry later.</p></body></html>""", html);
    }

    [Fact]
    public async Task Other_requests_go_to_the_next_middleware()
    {
        await using var a = await App(Api.Minimal, o => { o.Dir = AppBuild(); o.Skip("feed"); });
        Assert.Equal("static file", await Html(a, "/assets/app.css"));
        Assert.Equal("static file", await Html(a, "/article/a/b"));
        Assert.Equal("static file", (await Send(a, new Request(HttpMethod.Post, "/"))).Body);
        // the manifest is not served
        Assert.Equal(HttpStatusCode.NotFound, (await Send(a, Get("/sinter-embed.json"))).Status);
        // HEAD: the page's headers, no body, no requests
        var (s, res, body) = await Send(a, new Request(HttpMethod.Head, "/"));
        Assert.Equal((HttpStatusCode.OK, ""), (s, body));
        Assert.Equal("text/html; charset=utf-8", res.Content.Headers.ContentType!.ToString());
        // the API itself is still the API
        Assert.Equal("""{"tags":["a"]}""", await Html(a, "/api/tags"));
    }

    [Fact]
    public async Task A_resolver_takes_precedence_and_gets_what_the_template_cannot_express()
    {
        await using var a = await App(Api.Minimal, o =>
        {
            o.Dir = AppBuild();
            o.Resolve("feed", r =>
            {
                Assert.Equal("index.html", r.Page);
                Assert.Equal("/api/feed", r.Url);
                if (r.Headers.Cookie.ToString() is not { Length: > 0 } user) return ValueTask.FromResult(SlotData.None);
                return ValueTask.FromResult(SlotData.From($$"""{"feed":"{{user}}","page":"{{r.Param("page") ?? "1"}}"}""" ));
            });
            o.Resolve("tags", _ => ValueTask.FromResult<byte[]?>("""{"tags":["mine"]}"""u8.ToArray()));
        });
        var html = (await Send(a, Get("/?page=2").With("Cookie", "u=7"))).Body;
        Assert.Contains("""data-sn="5">{"feed":"u=7","page":"2"}</script>""", html);
        Assert.Contains("""data-sn="4">{"tags":["mine"]}</script>""", html);
        // signed out: the resolver leaves it to the browser
        Assert.Contains("""<script type="application/json" data-sn="5"></script>""", await Html(a, "/"));
    }

    [Fact]
    public async Task The_head_is_sent_before_the_data_and_slow_data_ends_the_page_at_the_time_limit()
    {
        var release = new TaskCompletionSource();
        await using var a = await App(Api.Minimal, o =>
        {
            o.Dir = AppBuild();
            o.Skip("feed");
            o.Timeout = TimeSpan.FromMilliseconds(300);
            o.Resolve("article", async r => { await release.Task; return SlotData.From("{}"); });
            // ignores its token: the page still ends at the time limit
            o.Resolve("comments", async _ => { await Task.Delay(5000); return SlotData.From("[]"); });
        });
        var t = Stopwatch.StartNew();
        var res = await a.GetTestClient().GetAsync("/article/x", HttpCompletionOption.ResponseHeadersRead);
        var body = await res.Content.ReadAsStreamAsync();
        // the first frame: everything before the first placeholder, while its data is still pending
        var buf = new byte[4096];
        var n = await body.ReadAsync(buf);
        Assert.Equal(Head + """<script type="application/json" data-sn="0">""", Encoding.UTF8.GetString(buf, 0, n));
        Assert.True(t.ElapsedMilliseconds < 200, $"{t.ElapsedMilliseconds} ms");
        release.SetResult();
        var rest = await new StreamReader(body).ReadToEndAsync();
        Assert.Equal("""{}</script><script type="application/json" data-sn="1"></script></head><body data-sn-failed><p>Error, please retry later.</p></body></html>""", rest);
        // the slow one waited for the time limit, not for itself
        Assert.InRange(t.ElapsedMilliseconds, 290, 2000);
    }

    [Theory, MemberData(nameof(Apis))]
    public async Task A_paginated_resource_is_requested_at_its_first_page(Api api)
    {
        // the build: `paginate="offset" page-size="10" size-param="limit"` over a tag from the path
        var dir = Build("paginated", """
            { "version": 2, "pages": [ { "file": "index.html", "paths": ["/tag/:tag"], "data": [
              { "id": 0, "resource": "articles", "src": ["/api/articles?tag=", { "url": "tag" }], "query": [["page", "1"], ["limit", "10"]] } ] } ] }
            """, ("index.html", """<head><script type="application/json" data-sn="0"></script></head>"""));
        await using var a = await App(api, o => o.Dir = dir);
        // the page's `$url` in the template, then the pager's first-page parameters, as the runtime writes them
        Assert.Contains("\"q\":\"tag=a+b&page=1&limit=10\"", await Html(a, "/tag/a%20b"));
    }

    [Theory, MemberData(nameof(Apis))]
    public async Task An_array_parameter_is_a_list(Api api)
    {
        var dir = Build("arrays", """
            { "version": 2, "pages": [ { "file": "index.html", "paths": ["/"], "arrays": ["tag"], "data": [
              { "id": 0, "resource": "articles", "src": ["/api/articles?tag=", { "url": "tag" }, "&limit=10"] },
              { "id": 1, "resource": "seen", "src": ["/api/seen"] } ] } ] }
            """, ("index.html", """<head><script type="application/json" data-sn="0"></script><script type="application/json" data-sn="1"></script></head>"""));
        await using var a = await App(api, o =>
        {
            o.Dir = dir;
            o.Resolve("seen", r => ValueTask.FromResult(SlotData.From($$"""{"tags":"{{string.Join("|", r.ParamValues("tag"))}}","x":"{{r.Param("x")}}","one":"{{r.Param("tag") ?? "-"}}"}""")));
        });
        // repeated keys in the request, as the runtime writes them; a list in the resolver's params
        var html = await Html(a, "/?tag=a&tag=b%20c&x=1&x=2");
        Assert.Contains("\"q\":\"tag=a&tag=b%20c&limit=10\"", html);
        Assert.Contains("""{"tags":"a|b c","x":"2","one":"-"}""", html);
        // none: the parameter is left out
        Assert.Contains("\"q\":\"limit=10\"", await Html(a, "/"));
    }

    [Theory, MemberData(nameof(Apis))]
    public async Task Unstreamed_the_page_is_one_piece_and_a_failure_is_its_status(Api api)
    {
        await using var a = await App(api, o => { o.Dir = AppBuild(); o.Skip("feed"); o.Stream = false; });
        var (status, res, html) = await Send(a, Get("/"));
        Assert.Equal(HttpStatusCode.OK, status);
        Assert.Equal(Encoding.UTF8.GetByteCount(html), res.Content.Headers.ContentLength);
        Assert.EndsWith("<main></main></body></html>", html);
        // the comments answer 500: a 502 with the error text instead of the page
        (status, _, html) = await Send(a, Get("/article/x"));
        Assert.Equal(HttpStatusCode.BadGateway, status);
        Assert.Equal("""<!DOCTYPE html><html><head><meta charset="utf-8"></head><body data-sn-failed><p>Error, please retry later.</p></body></html>""", html);
        // out of time: 504
        await using var slow = await App(api, o =>
        {
            o.Dir = AppBuild();
            o.Skip("feed");
            o.Stream = false;
            o.Timeout = TimeSpan.FromMilliseconds(50);
            o.Resolve("tags", async r => { await Task.Delay(5000, r.Cancellation); return SlotData.None; });
        });
        Assert.Equal(HttpStatusCode.GatewayTimeout, (await Send(slow, Get("/"))).Status);
    }

    [Fact]
    public async Task A_failure_redirects_to_the_error_page_when_there_is_one()
    {
        await using var a = await App(Api.Minimal, o =>
        {
            o.Dir = AppBuild();
            o.Skip("feed");
            o.ErrorRedirect = "/error?from=\"x\"<";
            o.ErrorText = "Try again <soon>";
        });
        var tail = (await Html(a, "/article/x")).Split("data-sn=\"1\">")[1];
        Assert.Equal(E("""</script><meta http-equiv="refresh" content="0;url=/error?from=&quot;x&quot;&lt;"><script>location.replace("/error?from=\"x\"‹")</script></head><body data-sn-failed><p>Try again &lt;soon&gt;</p></body></html>"""), tail);
    }

    [Fact]
    public async Task Data_left_to_the_browser_is_no_failure()
    {
        // a resolver's None, a skip, a `when` that does not hold: the page is sent whole, those placeholders empty
        await using var a = await App(Api.Minimal, o => { o.Dir = AppBuild(); o.Skip("feed"); o.Resolve("comments", _ => ValueTask.FromResult(SlotData.None)); });
        Assert.EndsWith("""<script type="application/json" data-sn="1"></script></head><body></body></html>""", await Html(a, "/article/x"));
    }

    [Fact]
    public async Task A_response_over_max_bytes_or_not_json_fails()
    {
        await using var a = await App(Api.Minimal, o => { o.Dir = AppBuild(); o.Skip("feed"); o.Skip("articles"); o.MaxBytes = 10; });
        Assert.Contains("data-sn-failed", await Html(a, "/"));
        await using var b = await App(Api.Minimal, o => { o.Dir = AppBuild(); o.Skip("feed"); o.Skip("articles"); },
            map: app => app.MapGet("/api/tags", () => "not json").WithOrder(-1));
        Assert.Contains("data-sn-failed", await Html(b, "/"));
    }

    [Fact]
    public async Task Upstream_over_http_and_allowed_origins_only()
    {
        // the API on a real socket
        var bld = WebApplication.CreateSlimBuilder();
        bld.WebHost.UseUrls("http://127.0.0.1:0");
        await using var server = bld.Build();
        MapMinimal(server);
        await server.StartAsync();
        var @base = server.Urls.First().TrimEnd('/');
        var dir = Build("upstream", $$"""
            { "version": 2, "pages": [ { "file": "index.html", "paths": ["/"], "data": [
            { "id": 0, "resource": "a", "src": ["/api/articles?tag=", { "url": "tag" }] },
            { "id": 1, "resource": "b", "src": ["{{@base}}/api/tags"] },
            { "id": 2, "resource": "c", "src": ["{{@base}}/api/articles"] },
            { "id": 3, "resource": "d", "src": ["http://elsewhere.invalid/api/tags"] },
            { "id": 4, "resource": "e", "src": [{ "url": "next" }] } ] } ] }
            """, ("index.html", """<head><script type="application/json" data-sn="0"></script><script type="application/json" data-sn="1"></script><script type="application/json" data-sn="2"></script><script type="application/json" data-sn="3"></script><script type="application/json" data-sn="4"></script></head>"""));
        // another origin, or a URL whose origin a value makes up: refused at startup
        var err = await Assert.ThrowsAsync<SinterException>(() => App(Api.Minimal, o => { o.Dir = dir; o.Upstream = @base; o.AllowOrigin(@base); }));
        Assert.Contains("2 placeholder(s) have no source", err.Message);
        Assert.Contains("index.html: `d`: `http://elsewhere.invalid/api/tags…` is on an origin not allowed with AllowOrigin(…)", err.Message);
        Assert.Contains("index.html: `e`:", err.Message);
        await using var a = await App(Api.Minimal, o => { o.Dir = dir; o.Upstream = @base; o.AllowOrigin(@base); o.Skip("d"); o.Skip("e"); });
        var html = (await Send(a, Get("/?tag=t&next=http%3A%2F%2Fevil.invalid%2F").With("Cookie", "s=1"))).Body;
        // same origin, through the upstream, with the cookie
        Assert.Contains("\"q\":\"tag=t\",\"who\":\"s=1\"", html);
        // an allowed origin: fetched, without the page's cookie
        Assert.Contains("""data-sn="1">{"tags":["a"]}</script>""", html);
        Assert.Contains(E("""data-sn="2">{"articles":[{"title":"‹/script>‹b>x"}],"q":"","who":"-"}</script>"""), html);
        // skipped: left to the browser
        Assert.Contains("""<script type="application/json" data-sn="3"></script>""", html);
        Assert.Contains("""<script type="application/json" data-sn="4"></script>""", html);
    }

    [Fact]
    public async Task A_page_from_another_build_is_refused()
    {
        var dir = Build("stale", """{ "version": 2, "pages": [ { "file": "index.html", "paths": ["/"], "data": [ { "id": 9, "resource": "a", "src": null } ] } ] }""",
            ("index.html", """<head><script type="application/json" data-sn="1"></script></head>"""));
        Assert.Contains("no placeholder for `a`", (await Assert.ThrowsAsync<SinterException>(() => App(Api.Minimal, o => { o.Dir = dir; o.Skip("a"); }))).Message);
        dir = Build("filled", """{ "version": 2, "pages": [ { "file": "index.html", "paths": ["/"], "data": [ { "id": 1, "resource": "a", "src": null } ] } ] }""",
            ("index.html", """<head><script type="application/json" data-sn="1">{}</script></head>"""));
        Assert.Contains("not empty", (await Assert.ThrowsAsync<SinterException>(() => App(Api.Minimal, o => { o.Dir = dir; o.Skip("a"); }))).Message);
        var none = Path.Combine(Path.GetTempPath(), "sinter-aspnetcore-none");
        Assert.Contains("sinter-embed.json", (await Assert.ThrowsAsync<SinterException>(() => App(Api.Minimal, o => o.Dir = none))).Message);
        dir = Build("v1", """{ "version": 1, "pages": [] }""");
        Assert.Contains("version 1 (this package reads version 2", (await Assert.ThrowsAsync<SinterException>(() => App(Api.Minimal, o => o.Dir = dir))).Message);
    }

    [Fact]
    public async Task Startup_refuses_placeholders_without_a_source_and_names_that_are_not_placeholders()
    {
        // `feed` has a `when` only the browser evaluates; in-process calls off, so no source for the paths
        var err = (await Assert.ThrowsAsync<SinterException>(() => App(Api.Minimal, o =>
        {
            o.Dir = AppBuild();
            o.InProcess = false;
            o.Resolve("artcles", _ => ValueTask.FromResult(SlotData.None));
        }))).Message;
        foreach (var want in new[]
        {
            "`artcles`: no page of the build has a placeholder for it",
            "index.html: `feed`: its `when` is a condition only the browser can evaluate; add Resolve(\"feed\", …) or Skip(\"feed\")",
            "index.html: `tags`: `/api/tags…` is a path of this origin, and there is no Upstream and InProcess is off",
            "article.html: `article`:",
        })
            Assert.Contains(want, err);
        // a page-qualified name covers that page's placeholder
        await using var ok = await App(Api.Minimal, o => { o.Dir = AppBuild(); o.Skip("index.html:feed"); });
        await Assert.ThrowsAsync<SinterException>(() => App(Api.Minimal, o => { o.Dir = AppBuild(); o.Skip("article.html:feed"); }));
    }

    [Fact]
    public async Task When_and_page_model_are_evaluated_from_the_url()
    {
        var dir = Build("when", """
            { "version": 2, "pages": [ { "file": "index.html", "paths": ["/"], "data": [
              { "id": 0, "resource": "articles", "src": ["/api/articles?tag=", { "url": "tag" }], "when": { "url": "feed", "ne": "following" },
                "query": [["offset", "0"], ["limit", "10"]],
                "start": { "url": "page", "key": "offset", "size": 10, "skip": true, "query": [["offset", "10"], ["limit", "10"]] } } ] } ] }
            """, ("index.html", """<head><script type="application/json" data-sn="0"></script></head>"""));
        await using var a = await App(Api.Minimal, o => o.Dir = dir);
        static string? Q(string html) => html.Split("\"q\":\"") is [_, var r, ..] ? r.Split('"')[0] : null;
        Assert.Equal("tag=x&offset=0&limit=10", Q(await Html(a, "/?tag=x")));
        Assert.Equal("offset=20&limit=10", Q(await Html(a, "/?page=3")));
        Assert.Equal("offset=0&limit=10", Q(await Html(a, "/?page=abc")));
        // `when` does not hold: no request, the placeholder empty
        Assert.Contains("""<script type="application/json" data-sn="0"></script>""", await Html(a, "/?feed=following"));
    }

    /// <summary>The build's `_redirects`: 301s from old file URLs (with the query), and a declared path rewritten to its file when its page has no embedded data.</summary>
    [Fact]
    public async Task Follows_the_sites_rules_301s_and_rewrites()
    {
        var dir = Build("routes", """
            { "version": 2, "pages": [
              { "file": "article.html", "paths": ["/article/:slug"], "data": [
                { "id": 0, "resource": "article", "src": ["/api/articles/", { "url": "slug" }] } ] } ],
              "routes": [
                { "from": "/about.html", "to": "/about/", "status": 301 },
                { "from": "/support", "to": "/help", "status": 200, "file": "help.html" },
                { "from": "/article/:slug", "to": "/article", "status": 200, "file": "article.html" } ] }
            """, ("article.html", Head + """<script type="application/json" data-sn="0"></script></head><body></body></html>"""));
        // the next middleware echoes the path it is asked for, as the static files would serve that file
        await using var a = await App(Api.Minimal, o => o.Dir = dir, fallback: ctx => $"file {ctx.Request.Path}{ctx.Request.QueryString}");
        var (s, res, _) = await Send(a, Get("/about.html?x=1"));
        Assert.Equal(HttpStatusCode.MovedPermanently, s);
        Assert.Equal("/about/?x=1", res.Headers.Location!.OriginalString);
        Assert.Equal("file /help.html?q=2", await Html(a, "/support?q=2"));
        // a page with data: answered by the middleware, data embedded
        var (s2, _, html) = await Send(a, Get("/article/hello"));
        Assert.Equal(HttpStatusCode.OK, s2);
        Assert.Contains("""{"article":{"slug":"hello"}}""", html);
        // anything else: as it was
        Assert.Equal("file /about/", await Html(a, "/about/"));
    }

    /// <summary>A site with languages: an unprefixed URL goes to the visitor's language (the `locale` cookie, else Accept-Language, else the base); 302; after Vite's base.</summary>
    [Fact]
    public async Task Sends_an_unprefixed_url_to_the_visitors_language()
    {
        var dir = Build("locales", """
            { "version": 2, "pages": [],
              "routes": [
                { "from": "/docs/about.html", "to": "/docs/about/", "status": 200, "file": "about.html", "choose": true },
                { "from": "/docs/about/", "to": "/docs/about/", "status": 200, "file": "about/index.html", "choose": true },
                { "from": "/docs/article/:slug", "to": "/docs/article", "status": 200, "file": "article.html", "choose": true } ],
              "locales": { "base": "en", "list": ["en", "de"], "at": "/docs/" } }
            """);
        await using var a = await App(Api.Minimal, o => o.Dir = dir);
        async Task<HttpResponseMessage> Go(string? cookie, string? lang, string uri)
        {
            var r = Get(uri);
            if (cookie is not null) r.With("Cookie", cookie);
            if (lang is not null) r.With("Accept-Language", lang);
            return (await Send(a, r)).Response;
        }
        var res = await Go("x=1; locale=de", "en", "/docs/article/hello?ref=x");
        Assert.Equal(HttpStatusCode.Found, res.StatusCode);
        Assert.Equal("/docs/de/article/hello?ref=x", res.Headers.Location!.OriginalString);
        Assert.Equal("Cookie, Accept-Language", string.Join(", ", res.Headers.Vary));
        Assert.Equal("/docs/de/about/", (await Go(null, "fr-FR, de-AT;q=0.8", "/docs/about/")).Headers.Location!.OriginalString);
        Assert.Equal("/docs/en/about/", (await Go(null, "fr", "/docs/about/")).Headers.Location!.OriginalString);
        // the old file URL: straight to the page in the language, one hop
        Assert.Equal("/docs/de/about/?x=1", (await Go("locale=de", null, "/docs/about.html?x=1")).Headers.Location!.OriginalString);
        // a page in a language: not a chooser
        Assert.Equal("static file", await Html(a, "/docs/de/about/"));
    }

    // ASP.NET Core: what the in-process calls go through

    [Theory, MemberData(nameof(Apis))]
    public async Task The_signed_in_user_reaches_an_authorized_endpoint_through_the_forwarded_cookie(Api api)
    {
        var dir = Build("me", """{ "version": 2, "pages": [ { "file": "index.html", "paths": ["/"], "data": [ { "id": 0, "resource": "me", "src": ["/api/me"] } ] } ] }""",
            ("index.html", """<head><script type="application/json" data-sn="0"></script></head>"""));
        await using var a = await App(api, o => o.Dir = dir,
            services: s =>
            {
                s.AddAuthentication("user").AddScheme<AuthenticationSchemeOptions, CookieUser>("user", null);
                s.AddAuthorization();
                if (api == Api.Mvc) s.AddControllers().AddApplicationPart(typeof(MeController).Assembly);
            },
            map: app => { if (api == Api.Minimal) app.MapGet("/api/me", (HttpContext c) => Results.Text($$"""{"name":"{{c.User.Identity!.Name}}"}""", "application/json")).RequireAuthorization(); });
        Assert.Contains("""data-sn="0">{"name":"ada"}</script>""", (await Send(a, Get("/").With("Cookie", "user=ada"))).Body);
        // signed out: the endpoint answers 401, so the page ends with the error text, as for any non-2xx
        Assert.Contains("data-sn-failed", await Html(a, "/"));
    }

    public sealed class Counter { public int N; }

    [Fact]
    public async Task Each_placeholder_has_a_service_scope_of_its_own()
    {
        var dir = Build("scope", """{ "version": 2, "pages": [ { "file": "index.html", "paths": ["/"], "data": [ { "id": 0, "resource": "a", "src": null }, { "id": 1, "resource": "b", "src": null } ] } ] }""",
            ("index.html", """<head><script type="application/json" data-sn="0"></script><script type="application/json" data-sn="1"></script></head>"""));
        SlotResolver count = r =>
        {
            var c = r.Services.GetRequiredService<Counter>();
            c.N++;
            return ValueTask.FromResult(SlotData.From($"{c.N}"));
        };
        await using var a = await App(Api.Minimal, o => { o.Dir = dir; o.Resolve("a", count); o.Resolve("b", count); }, services: s => s.AddScoped<Counter>());
        var html = await Html(a, "/");
        Assert.Contains("data-sn=\"0\">1</script>", html);
        Assert.Contains("data-sn=\"1\">1</script>", html);
    }

    [Fact]
    public async Task A_resolver_that_throws_ends_the_page_with_the_error_text()
    {
        var dir = Build("throws", """{ "version": 2, "pages": [ { "file": "index.html", "paths": ["/"], "data": [ { "id": 0, "resource": "a", "src": null } ] } ] }""",
            ("index.html", """<head><script type="application/json" data-sn="0"></script></head>"""));
        await using var a = await App(Api.Minimal, o => { o.Dir = dir; o.Resolve("a", (SlotResolver)(_ => throw new InvalidOperationException("no"))); });
        Assert.Contains("data-sn-failed", await Html(a, "/"));
    }
}

public sealed class PlacementTests
{
    /// <summary>
    /// UseSinter after explicit routing and authentication (the order a typical template has): the in-process
    /// calls still go through routing and authentication of their own.
    /// </summary>
    [Fact]
    public async Task After_routing_and_authentication_as_well()
    {
        var dir = Build("placed", """{ "version": 2, "pages": [ { "file": "index.html", "paths": ["/"], "data": [ { "id": 0, "resource": "me", "src": ["/api/me"] } ] } ] }""",
            ("index.html", """<head><script type="application/json" data-sn="0"></script></head>"""));
        var b = WebApplication.CreateSlimBuilder();
        b.WebHost.UseTestServer();
        b.Services.AddAuthentication("user").AddScheme<AuthenticationSchemeOptions, CookieUser>("user", null);
        b.Services.AddAuthorization();
        b.Services.AddSinter(o => o.Dir = dir);
        await using var app = b.Build();
        app.UseRouting();
        app.UseAuthentication();
        app.UseAuthorization();
        app.UseSinter();
        app.MapGet("/api/me", (HttpContext c) => Results.Text($$"""{"name":"{{c.User.Identity!.Name}}"}""", "application/json")).RequireAuthorization();
        await app.StartAsync();
        Assert.Contains("""data-sn="0">{"name":"ada"}</script>""", (await Send(app, Get("/").With("Cookie", "user=ada"))).Body);
    }
}
