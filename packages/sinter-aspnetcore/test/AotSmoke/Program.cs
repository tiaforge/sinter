// A NativeAOT app: the build compiled in by [SinterEmbed], its data from a minimal API in-process and a
// resolver whose value is serialized with source-generated JSON.
using System.Text.Json.Serialization;
using Sinter.AspNetCore;

var builder = WebApplication.CreateSlimBuilder(args);
builder.Logging.ClearProviders();
builder.Services.ConfigureHttpJsonOptions(o => o.SerializerOptions.TypeInfoResolverChain.Insert(0, AppJson.Default));
builder.Services.AddSingleton<Store>();
builder.Services.AddSinter(Web.Build, o => o.Dir = args[0]);

var app = builder.Build();
app.UseSinter();
app.MapGet("/api/tags", () => new Tags(["aot"]));
app.Run($"http://127.0.0.1:{args[1]}");

record Tags(string[] tags);
record Articles(string[] articles);

sealed class Store
{
    public Task<Articles> All() => Task.FromResult(new Articles(["native"]));
}

[SinterEmbed, SinterSkip("user")]
static partial class Web
{
    [SinterResolve("articles")]
    static Task<Articles> Articles(Store store) => store.All();
}

[JsonSerializable(typeof(Tags))]
[JsonSerializable(typeof(Articles))]
partial class AppJson : JsonSerializerContext;
