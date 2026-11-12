using System.ComponentModel;
using System.Security.Claims;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization.Metadata;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Options;

namespace Sinter.AspNetCore;

/// <summary>
/// What a resolver receives: the placeholder's resource, the request the build describes for it (if
/// any), the page's <c>$url</c> and the page request.
/// </summary>
public sealed class SlotRequest : IAsyncDisposable
{
    private readonly IServiceScopeFactory _scopes;
    private AsyncServiceScope? _scope;

    internal SlotRequest(HttpContext context, string page, string resource, string? url, IReadOnlyDictionary<string, string> @params, CancellationToken cancellation)
    {
        HttpContext = context;
        Page = page;
        Resource = resource;
        Url = url;
        Params = @params;
        Cancellation = cancellation;
        _scopes = context.RequestServices.GetRequiredService<IServiceScopeFactory>();
    }

    /// <summary>The page's file in the build (<c>index.html</c>).</summary>
    public string Page { get; }
    /// <summary>The resource's name.</summary>
    public string Resource { get; }
    /// <summary>
    /// The request the build describes, filled from <c>$url</c>: the resource's <c>src</c>, a paginated one
    /// at its first page (or the page <c>start-page</c> names); null when the build could not describe it,
    /// or its <c>when</c> does not hold for this URL.
    /// </summary>
    public string? Url { get; }
    /// <summary>The page URL's parameters: the query, then the path's <c>:name</c> segments.</summary>
    public IReadOnlyDictionary<string, string> Params { get; }
    /// <summary>The page request (its headers include cookies: the data can be the user's).</summary>
    public HttpContext HttpContext { get; }
    /// <summary>The page request's headers.</summary>
    public IHeaderDictionary Headers => HttpContext.Request.Headers;
    /// <summary>The page request's user.</summary>
    public ClaimsPrincipal User => HttpContext.User;
    /// <summary>Cancelled when the page's time limit passes or the visitor goes away.</summary>
    public CancellationToken Cancellation { get; }

    /// <summary>
    /// Services from a scope of this placeholder's own: the page's placeholders are filled in parallel,
    /// so a scoped service such as a <c>DbContext</c> is never shared between them.
    /// </summary>
    public IServiceProvider Services => (_scope ??= _scopes.CreateAsyncScope()).ServiceProvider;

    /// <summary>A page URL parameter, or null.</summary>
    public string? Param(string name) => Params.TryGetValue(name, out var v) ? v : null;

    /// <inheritdoc/>
    public ValueTask DisposeAsync() => _scope?.DisposeAsync() ?? ValueTask.CompletedTask;
}

/// <summary>
/// What a resolver gives: the JSON body the API would return (the whole body, as the browser would get
/// it), or <see cref="None"/> to leave the resource to the browser.
/// </summary>
public readonly struct SlotData
{
    private SlotData(ReadOnlyMemory<byte> json) { Json = json; HasValue = true; }

    /// <summary>No data from the server: the browser requests it.</summary>
    public static SlotData None => default;
    /// <summary>Whether there is data.</summary>
    public bool HasValue { get; }
    /// <summary>The JSON body, UTF-8.</summary>
    public ReadOnlyMemory<byte> Json { get; }

    /// <summary>A UTF-8 JSON body; null is <see cref="None"/>.</summary>
    public static SlotData From(byte[]? utf8Json) => utf8Json is null ? None : new(utf8Json);
    /// <summary>A UTF-8 JSON body; null is <see cref="None"/>.</summary>
    public static SlotData From(ReadOnlyMemory<byte>? utf8Json) => utf8Json is { } j ? new(j) : None;
    /// <summary>A JSON text; null is <see cref="None"/>.</summary>
    public static SlotData From(string? json) => json is null ? None : new(Encoding.UTF8.GetBytes(json));
    /// <summary>The same.</summary>
    public static SlotData From(SlotData data) => data;

    /// <summary>A value as JSON, with the given type information (System.Text.Json source generation); null is <see cref="None"/>.</summary>
    public static SlotData Serialize<T>(T? value, JsonTypeInfo<T> type) =>
        value is null ? None : new(JsonSerializer.SerializeToUtf8Bytes(value, type));

    /// <summary>
    /// A value as JSON, serialized as minimal APIs serialize it: with the app's
    /// <see cref="Microsoft.AspNetCore.Http.Json.JsonOptions"/> (register your <c>JsonSerializerContext</c>
    /// there for NativeAOT, as for minimal APIs). Null is <see cref="None"/>.
    /// </summary>
    [EditorBrowsable(EditorBrowsableState.Never)]
    public static SlotData Serialize<T>(T? value, SlotRequest request)
    {
        if (value is null) return None;
        var options = request.HttpContext.RequestServices.GetRequiredService<IOptions<Microsoft.AspNetCore.Http.Json.JsonOptions>>().Value.SerializerOptions;
        var type = (JsonTypeInfo<T>)options.GetTypeInfo(typeof(T));
        return new(JsonSerializer.SerializeToUtf8Bytes(value, type));
    }
}
