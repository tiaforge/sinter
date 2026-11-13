// RealWorld's build served with its API in the same app: the middleware calls the app's endpoints
// in-process, the case bench/in-process measures against the other layers. The API answers each route
// with recorded JSON (bench/in-process/data), so every layer's API does the same, trivial work. The
// build's absolute API URLs are made same-origin paths by bench/in-process/run.sh.
//
//   dotnet publish -c Release -o out && out/InProcess <dist> [port] <data dir>
using System.IO.Compression;
using Microsoft.AspNetCore.ResponseCompression;

if (args.Length < 3) { Console.Error.WriteLine("usage: InProcess <dist> [port] <data dir>"); return 1; }
var (dist, port, data) = (Path.GetFullPath(args[0]), args[1], args[2]);
byte[] Read(string f) => File.ReadAllBytes(Path.Combine(data, f + ".json"));
var (articles, tags, article, comments, profile) = (Read("articles"), Read("tags"), Read("article"), Read("comments"), Read("profile"));

var builder = WebApplication.CreateSlimBuilder(args);
builder.Logging.ClearProviders();
builder.WebHost.ConfigureKestrel(k => k.AddServerHeader = false);
builder.Services.AddResponseCompression(o => o.Providers.Add<GzipCompressionProvider>());
builder.Services.Configure<GzipCompressionProviderOptions>(o => o.Level = CompressionLevel.Optimal);
builder.Services.AddSinter(o =>
{
    o.Dir = dist;
    o.Skip("profile.html:articles");
});

var app = builder.Build();
app.UseResponseCompression();
app.UseSinter();
app.MapGet("/api/articles", () => Results.Bytes(articles, "application/json"));
app.MapGet("/api/tags", () => Results.Bytes(tags, "application/json"));
app.MapGet("/api/articles/{slug}", (string slug) => Results.Bytes(article, "application/json"));
app.MapGet("/api/articles/{slug}/comments", (string slug) => Results.Bytes(comments, "application/json"));
app.MapGet("/api/profiles/{username}", (string username) => Results.Bytes(profile, "application/json"));
Console.WriteLine($"http://127.0.0.1:{port}");
app.Run($"http://127.0.0.1:{port}");
return 0;
