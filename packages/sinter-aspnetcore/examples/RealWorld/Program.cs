// RealWorld's build (examples/realworld, built with SINTER_EMBED=1) served with its data in the page,
// as packages/sinter-axum/examples/realworld.rs serves it. Every placeholder but one is described by the
// build, on an API origin allowed here. The profile's article list picks its query parameter with a
// ternary (`author` or `favorited`), which the build cannot describe: a resolver makes that request.
// RealWorld keeps its token in localStorage, so this server embeds the signed-out view: it is for measuring.
//
//   dotnet publish -c Release -o out && out/RealWorld <dist> [port] [api origin]
using System.IO.Compression;
using Microsoft.AspNetCore.ResponseCompression;
using Microsoft.Extensions.FileProviders;
using Sinter.AspNetCore;

if (args.Length < 1) { Console.Error.WriteLine("usage: RealWorld <dist> [port] [api origin]"); return 1; }
var dist = Path.GetFullPath(args[0]);
var port = args.Length > 1 ? args[1] : "4370";
var api = args.Length > 2 ? args[2] : "http://localhost:4400";

var builder = WebApplication.CreateSlimBuilder(args);
builder.Logging.ClearProviders();
builder.WebHost.ConfigureKestrel(k => k.AddServerHeader = false);
builder.Services.AddResponseCompression(o => { o.Providers.Add<GzipCompressionProvider>(); o.MimeTypes = [.. ResponseCompressionDefaults.MimeTypes, "image/svg+xml"]; });
builder.Services.Configure<GzipCompressionProviderOptions>(o => o.Level = CompressionLevel.Optimal);
var http = new HttpClient(new SocketsHttpHandler { PooledConnectionLifetime = TimeSpan.FromMinutes(2) });
builder.Services.AddSinter(o =>
{
    o.Dir = dist;
    o.AllowOrigin(api);
    o.HttpClient = http;
    o.Timeout = TimeSpan.FromMilliseconds(800);
    // ?author=… on the profile's own tab, ?favorited=… on its favorites
    o.Resolve("profile.html:articles", async r =>
    {
        if (r.Param("username") is not { } user) return null;
        var by = r.Param("tab") == "favorites" ? "favorited" : "author";
        var offset = (SinterUrl.ToPage(r.Param("page")) - 1) * 10;
        using var res = await http.GetAsync($"{api}/api/articles?{by}={Uri.EscapeDataString(user)}&offset={offset}&limit=10", r.Cancellation);
        return res.IsSuccessStatusCode ? await res.Content.ReadAsByteArrayAsync(r.Cancellation) : null;
    });
});

var app = builder.Build();
app.UseResponseCompression();
// hashed assets cached for good, everything else revalidated
app.Use((ctx, next) =>
{
    ctx.Response.OnStarting(() =>
    {
        if (!ctx.Response.Headers.ContainsKey("Cache-Control") || ctx.Request.Path.StartsWithSegments("/assets"))
            ctx.Response.Headers.CacheControl = ctx.Request.Path.StartsWithSegments("/assets") ? "public, max-age=31536000, immutable" : "no-cache";
        return Task.CompletedTask;
    });
    return next(ctx);
});
app.UseSinter();
var files = new PhysicalFileProvider(dist);
app.UseDefaultFiles(new DefaultFilesOptions { FileProvider = files });
app.UseStaticFiles(new StaticFileOptions { FileProvider = files });
Console.WriteLine($"http://127.0.0.1:{port}");
app.Run($"http://127.0.0.1:{port}");
return 0;
