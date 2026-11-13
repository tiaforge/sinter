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
// gzip at zlib level 6, as tower-http's default (CompressionLevel.Optimal is a lower level on .NET's zlib-ng)
builder.Services.AddResponseCompression(o => o.Providers.Add(new Gzip6()));
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

/// <summary>gzip at zlib level 6, flushing when the response flushes (the head of a page goes out first).</summary>
sealed class Gzip6 : ICompressionProvider
{
    public string EncodingName => "gzip";
    public bool SupportsFlush => true;
    public Stream CreateStream(Stream outputStream) => new GZipStream(outputStream, new ZLibCompressionOptions { CompressionLevel = 6 }, leaveOpen: true);
}
