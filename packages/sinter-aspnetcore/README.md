# Sinter.AspNetCore

Serve a [sinter](https://github.com/tiaforge/sinter#readme) app from ASP.NET Core with its API data already in the page. The first frame shows the data, the browser makes no API request on load, and nothing is rendered on the server.

You add one middleware. For each page, it calls your API (your minimal APIs and MVC controllers, in-process) and writes the JSON into the HTML as it's sent. It is NativeAOT-compatible, and a source generator compiles the build into your assembly and checks it when your project compiles.

The server layer is optional: without it, sinter pages fetch their data in the browser. It does what [`sinter-axum`](../sinter-axum#readme) does for Rust, option for option: the server only writes JSON into the `<script type="application/json" data-sn-data>` slots in the head of each page, which the build lists in `sinter-embed.json` ([contract](https://github.com/tiaforge/sinter/blob/main/docs/first-paint.md)).

## Quick start

**1. Build the frontend for a server.** In its Vite config, `sinter({ embed: true })` (needs `@tiaforge-ui/sinter` 0.13 or newer). The build then leaves an empty data slot in each page for every resource whose request the page's URL decides, and lists them in `dist/sinter-embed.json`. The browser no longer requests those itself: their data comes with the page.

**2. Add the package**, and name the build in your project file:

```xml
<ItemGroup>
  <PackageReference Include="Sinter.AspNetCore" Version="0.17.0" />
</ItemGroup>
<PropertyGroup>
  <!-- the frontend's build output, relative to this project -->
  <SinterBuild>../web/dist</SinterBuild>
</PropertyGroup>
```

**3. Add the middleware** in front of the static files:

```csharp
using Sinter.AspNetCore;

var builder = WebApplication.CreateSlimBuilder(args);
builder.Services.AddSinter(Web.Build);          // the build, checked when this project compiles

var app = builder.Build();
app.UseSinter();
app.UseDefaultFiles();
app.UseStaticFiles();                           // the build's assets (or MapStaticAssets)
app.MapGet("/api/articles", (ArticleStore s) => s.List());
app.MapControllers();                           // MVC controllers work the same way
app.Run();

[SinterEmbed]
static partial class Web;
```

For each page request, the middleware calls your endpoints in-process, passing on the request's cookies. Other requests pass through untouched.

The page is sent head first, before the data is in, so its status is `200` from the start. If the data then can't be fetched, the rest of the page isn't sent: the response ends with an error text, or a redirect to your error page (see [What the middleware does](#what-the-middleware-does)).

## The compile-time check

`[SinterEmbed]` reads the build's `sinter-embed.json` when your project compiles (the `<SinterBuild>` directory). It's a compile error when the build has a slot your configuration can't fill, and the error names the page, the resource and the fix:

```text
error SINTER003: index.html: `articles`: the build could not describe its request (its `src`
calls a helper, or reads something other than `$url`). Add [SinterResolve("articles")] to a
method that gives its data, or [SinterSkip("articles")] to leave it to the browser.
```

A name that no slot has (a typo) is an error too, at the name. A name applies to every page; `"profile.html:articles"` names one page's slot. The diagnostics:

| Code | When |
| --- | --- |
| `SINTER001` | no `<SinterBuild>`, or no `sinter-embed.json` there (build the frontend first) |
| `SINTER002` | the manifest can't be read (not version 2) |
| `SINTER003` | a slot without a source |
| `SINTER004` | a name no slot has |
| `SINTER005`, `SINTER006` | a resolver that isn't static, or doesn't return data |
| `SINTER007` | the class (or a class it is nested in) isn't `partial` |

The manifest is compiled into the assembly as code: nothing is parsed at startup. `UseSinter()` refuses a build directory from a different build, so the frontend and the server can't drift apart. At run time the pages are read from the `<SinterBuild>` path relative to the content root (which `dotnet run` sets to the project directory); if they are somewhere else, say so with `o.Dir`:

```csharp
builder.Services.AddSinter(Web.Build, o => o.Dir = "/srv/dist");
```

Without the generator, `AddSinter(o => o.Dir = "dist")` reads the manifest at startup and does the same checks in `UseSinter()`, all problems in one exception.

## Where the data comes from

The build records each page's API requests, including the first page of a paginated list and simple `when` conditions on the URL, so you usually only say how to reach the API:

| Your API | Configure |
| --- | --- |
| Endpoints of the same app: minimal APIs, MVC controllers | nothing (in-process, the default) |
| A separate server, called by the frontend at same-origin paths (`/api/...`) | `o.Upstream = "http://127.0.0.1:4000"` |
| Another origin, called by the frontend at absolute URLs (`https://api.example.com/...`) | `o.AllowOrigin("https://api.example.com")` |

`UseSinter()` also checks this: an origin that isn't allowed is an error at startup.

**In-process calls** go through endpoint routing as a request would, in a pipeline of their own: routing, CORS, authentication and authorization (each when its services are registered), then the endpoint. So `[Authorize]`, `.RequireAuthorization()`, route constraints and filters apply. Each call has its own `HttpContext` and service scope, and no socket or HTTP parsing. Endpoints can be mapped before or after `UseSinter()`. To run more middleware for these calls (a tenant resolver, say), add it with `o.ConfigureApi(b => b.UseMiddleware<…>())`.

### Resolvers: your own code for one resource

A resolver is your code for one resource; it produces that resource's data instead of the middleware making the request. It usually calls the same code as your API handler, such as a database query.

You need one when the build can't describe the request: the frontend's `src` calls a helper or chooses between parameters with a ternary, or its `when` is more than a comparison of URL values with strings. The compile-time check tells you which ones.

With the generator, a resolver is a static method. Its parameters are bound when the project compiles (no reflection): `SlotRequest`, `HttpContext`, `CancellationToken`, `ClaimsPrincipal`, `IServiceProvider`, or any service. It returns the value, or a `Task` or `ValueTask` of it:

```csharp
[SinterEmbed, SinterSkip("user")]
static partial class Web
{
    // the API handler and the resolver share one service
    [SinterResolve("profile.html:articles")]
    static Task<ArticleList?> ProfileArticles(SlotRequest req, ArticleStore store, CancellationToken ct) =>
        store.ByAuthor(req.Param("username"), (int)SinterUrl.ToPage(req.Param("page")), ct);
}
```

A value is serialized as minimal APIs serialize it, with the app's `JsonOptions` (under NativeAOT, add your `JsonSerializerContext` there, as for minimal APIs). A `byte[]` or `string` is taken as the JSON body. `null` leaves the resource to the browser.

A `SlotRequest` has:

- `Params` (and `Param(name)`, `ParamValues(name)`): the page URL's parameters, each a `UrlParam`: query parameters and named path segments (`/article/:slug` gives `slug`); an array parameter (one a `<select multiple>` or a checkbox with a `value` binds: `?tag=a&tag=b`) is a list, `Values` (`Param(name)` is null for it);
- `HttpContext`, `Headers`, `User`: the page request;
- `Url`: the URL the middleware would request, if the build describes one;
- `Page`, `Resource`: which slot it is;
- `Services`: a service scope of this slot's own. A page's slots are filled in parallel, so a scoped `DbContext` is never shared between them;
- `Cancellation`: cancelled at the page's time limit, or when the visitor leaves.

Without the generator, register resolvers on the options:

```csharp
builder.Services.AddSinter(o =>
{
    o.Dir = "dist";
    o.Resolve("profile.html:articles", AppJson.Default.ArticleList, async req =>
        await req.Services.GetRequiredService<ArticleStore>().ByAuthor(req.Param("username"), 1, req.Cancellation));
    o.Skip("user");
});
```

A resolver takes precedence over the automatic request, so you can also use one to skip the in-process round trip for a resource the build does describe.

## Signed-in users

The middleware fetches the data before any of the page's JavaScript runs, so the API sees only what the browser sent with its request for the page. The page uses the embedded data as is and doesn't request it again on load, so what the API returns here is what the user sees.

Which case are you in?

1. **The data is the same for everyone** (public articles, tags). Nothing to do.
2. **The data is per user, and the session is a cookie** (cookie authentication, Identity). Nothing to do. The browser's request for the page includes the session cookie, and the middleware passes it on to the in-process call (which authenticates it as any request) and to `Upstream`, so your API sees the same user. Requests to `AllowOrigin` URLs get no cookies, as sinter's own requests to another origin don't either.
3. **The data is per user, and the frontend sends a token from JavaScript** (kept in `localStorage`, sent as `Authorization`). The request for the page doesn't include the token, so the API would answer as if signed out, and a signed-in user would see signed-out data on every page load. Leave these resources to the browser:
   - in the frontend, `early="off"` on the resource. It already means "a request middleware changes this request", so the build gives it no slot;
   - or on the server, `[SinterSkip("articles")]` (`o.Skip("articles")`).

Pages are sent with `Cache-Control: private, no-cache`, so a shared cache never gives one user's page to another.

## Options

| Option | Default |
| --- | --- |
| `o.Timeout`: how long a page waits for all its data | 500 ms |
| `o.Forward`: the page request's headers passed on to in-process and upstream calls | `Cookie`, `Authorization`, `Accept-Language` |
| `o.MaxBytes`: the largest response put into a page | 2 MiB |
| `o.Stream = false`: send each page in one piece instead of head first; a failure is then a real `502` (`504` on the time limit) | head first |
| `o.ErrorText`: sent instead of the rest of a page whose data failed | `Error, please retry later.` |
| `o.ErrorRedirect`: where the browser goes then (a `meta` refresh and `location.replace`); serve that page with an error status | none |
| `o.CacheControl`: the pages' `Cache-Control` header | `private, no-cache` |
| `o.Dir`: where the pages are at run time (relative to the content root) | the `<SinterBuild>` path |
| `o.InProcess = false`: no in-process calls (with `Upstream` for same-origin paths) | in-process |
| `o.HttpClient`: the client for `Upstream` and allowed origins | one of its own |
| `o.ConfigureApi(…)`: middleware for in-process calls, before the endpoint | none |

## What the middleware does

- **At startup (`UseSinter()`):** it takes the manifest (compiled in, or read from `sinter-embed.json`), checks that every slot has a source, and splits each page at its slots. The slots are the last thing in the page's `<head>`, after the stylesheets and scripts.
- **On a GET for a page:**
  - it sends the HTML up to the first slot right away, so the browser loads stylesheets and scripts while the data is fetched;
  - it fetches every slot's data in parallel, for this URL: the URL's values in the request, the page a paginated list starts at, and no request when the resource's `when` doesn't hold;
  - it writes the data, with `<` escaped so it can't break out of its `<script>`, then the rest of the page.
- **When a slot's data can't be fetched** (the API errors or can't be reached, a non-2xx or non-JSON response, one over `MaxBytes`, the time limit, a resolver that throws), the page is not sent: the middleware ends the response there with the error text in the page's body, marked so the page's scripts don't start, and with `o.ErrorRedirect` sends the browser to your error page. It logs a warning with the page, the resource and why. A 404 from the API counts too, so a missing article shows the error text, not the page's own not-found state. A resolver that ignores its `CancellationToken` doesn't hold the page past the time limit.
- **The site's URLs:** it follows the same rules as the build's `_redirects`, which it reads from the manifest: a permanent redirect from a page's old file URL (`/about.html` to `/about/`, with the query); a path a page declares in `data-sn-path` (`/article/hello`) answered from that page's file, with its data written in, or passed on as that file to the next middleware (the static files); and, on a site with languages, a `302` from an unprefixed URL to the visitor's language (the `locale` cookie, else `Accept-Language`, else the base). So the app needs no routes of its own for its pages ([page URLs](../../docs/static-pages.md#page-urls)).
- **No data is not a failure:** a resolver's `null`, a skip, or a `when` that doesn't hold leaves the slot empty, and the browser requests that data itself.
- **What it never does:** fetch a URL whose host comes from the page's URL, or serve `sinter-embed.json` (it answers 404).

Put `UseSinter()` before the static files. It can come before or after `UseRouting()`, `UseAuthentication()` and `UseAuthorization()`: its in-process calls have routing and authentication of their own. With endpoint-based static files (`MapStaticAssets`), call `UseRouting()` after `UseSinter()`, so that a rewritten path is routed to its file.

## NativeAOT

The package is trimming- and AOT-safe (`IsAotCompatible`). Nothing in it uses reflection: the manifest is generated code or read with `JsonDocument`, resolvers are bound by the generator, and values are serialized through `JsonTypeInfo`. The repository's CI publishes a NativeAOT app with trim and AOT warnings as errors and checks its pages (`test/AotSmoke`). MVC controllers don't support NativeAOT (an ASP.NET Core limit); the middleware serves them in apps that don't publish with it.

## What the browser receives

For the frontend, a resource is just a resource:

```html
<sn-resource name="articles" src="/api/articles?tag={$url.tag}" key="slug" items="articles"></sn-resource>
```

With `embed: true`, the build gives it an empty slot at the end of the head and lists its request in `sinter-embed.json`:

```html
<!-- dist/index.html -->
<script type="application/json" data-sn="0"></script>
```

```json
{ "id": 0, "resource": "articles", "src": ["/api/articles?tag=", { "url": "tag" }] }
```

For a request to `/?tag=rust`, the middleware requests `/api/articles?tag=rust` from your API and writes the response body into the slot:

```html
<script type="application/json" data-sn="0">{"articles":[{"slug":"hello","title":"Hello"}],"articlesCount":1}</script>
```

The body goes in exactly as the API returned it (`items="articles"` picks the list out of it in the browser), except that every `<` is escaped. The bindings over it, rows included, render while the page is parsed.

## Performance

With the API in the same app, one core serves 22,562 RealWorld home pages per second uncompressed (4,619 with gzip), published with NativeAOT: 79% of sinter-axum's 28,621 on the same machine (method and numbers in [docs/first-paint-comparison.md](https://github.com/tiaforge/sinter/blob/main/docs/first-paint-comparison.md#with-the-api-in-the-same-app)). At startup, a build compiled in by `[SinterEmbed]` parses no JSON: the pages are read and cut at their slots, and that's all.

## Development

```sh
dotnet test                 # net8.0 and net10.0: the middleware (minimal APIs and MVC) and the generator
test/AotSmoke/run.sh        # a NativeAOT publish, warnings as errors, and its pages checked
```

To run the RealWorld server used in the measurements (frontend built with `SINTER_EMBED=1`):

```sh
dotnet publish -c Release -o out examples/RealWorld
out/RealWorld ../../examples/realworld/dist 4370 http://localhost:4400
```
