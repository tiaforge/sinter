using System.Text.Json.Serialization.Metadata;
using Microsoft.AspNetCore.Builder;

namespace Sinter.AspNetCore;

/// <summary>A resolver: your code for one resource's data.</summary>
public delegate ValueTask<SlotData> SlotResolver(SlotRequest request);

/// <summary>
/// The configuration: a build's output directory and where the data comes from. The middleware checks
/// it at startup (in <c>UseSinter</c>) and refuses one that leaves a placeholder without a source.
/// </summary>
/// <remarks>
/// Where a placeholder's data comes from, first match:
/// <list type="number">
/// <item><see cref="Resolve(string, SlotResolver)"/>: your function for that resource;</item>
/// <item><see cref="Skip"/>: none, the browser requests it;</item>
/// <item>the request the build describes: a same-origin path goes to <see cref="Upstream"/> if set, else to
/// the app's own endpoints (minimal APIs, MVC controllers), called in-process; an absolute URL is fetched
/// only from an origin allowed with <see cref="AllowOrigin"/>.</item>
/// </list>
/// </remarks>
public sealed class SinterOptions
{
    internal Dictionary<string, SlotResolver> Resolvers { get; } = new(StringComparer.Ordinal);
    internal HashSet<string> Skips { get; } = new(StringComparer.Ordinal);
    internal List<string> Origins { get; } = [];
    internal List<Action<IApplicationBuilder>> ApiMiddleware { get; } = [];
    internal SinterCompiledBuild? Compiled { get; set; }

    /// <summary>
    /// Where the build's pages are at run time: a directory with <c>sinter-embed.json</c> (relative to the
    /// content root). Defaults to the directory [SinterEmbed] was compiled against.
    /// </summary>
    public string? Dir { get; set; }

    /// <summary>
    /// Same-origin paths go to the app's own endpoints in-process (default true): no socket and no HTTP
    /// parsing, through routing, CORS, authentication and authorization as a request would.
    /// </summary>
    public bool InProcess { get; set; } = true;

    /// <summary>
    /// An API on another server, for same-origin paths (<c>http://127.0.0.1:4000</c>): where the page's own
    /// origin proxies <c>/api</c> to. Takes precedence over in-process calls when set.
    /// </summary>
    public string? Upstream { get => _upstream; set => _upstream = value?.TrimEnd('/'); }
    private string? _upstream;

    /// <summary>The page request's headers passed on to in-process and upstream requests (default <c>Cookie</c>, <c>Authorization</c>, <c>Accept-Language</c>).</summary>
    public IList<string> Forward { get; set; } = ["Cookie", "Authorization", "Accept-Language"];

    /// <summary>How long a page waits for its data, all placeholders together (default 500 ms).</summary>
    public TimeSpan Timeout { get; set; } = TimeSpan.FromMilliseconds(500);

    /// <summary>The largest response put into a page (default 2 MiB).</summary>
    public int MaxBytes { get; set; } = 2 << 20;

    /// <summary>
    /// Whether the page is streamed (default): the head up to the first placeholder goes out at once, so
    /// the browser loads stylesheets and scripts while the data is fetched. Without it, the page is sent in
    /// one piece once the data is in, and a failure is its status (502, 504 on the time limit).
    /// </summary>
    public bool Stream { get; set; } = true;

    /// <summary>The pages' <c>Cache-Control</c> (default <c>private, no-cache</c>: the data may be the user's).</summary>
    public string CacheControl { get; set; } = "private, no-cache";

    /// <summary>The text sent instead of the rest of a page whose data could not be fetched.</summary>
    public string ErrorText { get; set; } = "Error, please retry later.";

    /// <summary>
    /// Where the browser goes when a page's data could not be fetched (<c>/error.html</c>): a page you serve
    /// with the error's status. The text is shown too, if the browser does not go.
    /// </summary>
    public string? ErrorRedirect { get; set; }

    /// <summary>The client for <see cref="Upstream"/> and allowed origins (default: one of the middleware's own).</summary>
    public HttpClient? HttpClient { get; set; }

    /// <summary>
    /// An origin whose absolute URLs are fetched (<c>https://api.example.com</c>), without the page's headers:
    /// sinter's own requests to another origin carry no cookies either.
    /// </summary>
    public SinterOptions AllowOrigin(string origin)
    {
        Origins.Add(origin.TrimEnd('/'));
        return this;
    }

    /// <summary>
    /// Your function for a resource's data: <c>"articles"</c> applies to every page,
    /// <c>"profile.html:articles"</c> to one. It takes precedence over the request the build describes.
    /// </summary>
    public SinterOptions Resolve(string resource, SlotResolver resolver)
    {
        Resolvers[resource] = resolver;
        return this;
    }

    /// <summary>Your function for a resource's data, as a UTF-8 JSON body (null leaves it to the browser).</summary>
    public SinterOptions Resolve(string resource, Func<SlotRequest, ValueTask<byte[]?>> resolver) =>
        Resolve(resource, async r => SlotData.From(await resolver(r).ConfigureAwait(false)));

    /// <summary>Your function for a resource's data, as a value serialized with the type information given (null leaves it to the browser).</summary>
    public SinterOptions Resolve<T>(string resource, JsonTypeInfo<T> type, Func<SlotRequest, ValueTask<T?>> resolver) =>
        Resolve(resource, async r => SlotData.Serialize(await resolver(r).ConfigureAwait(false), type));

    /// <summary>A resource the server does not fill: the browser requests it (data only the browser can request, such as the user's with a token from JavaScript). Names as for <see cref="Resolve(string, SlotResolver)"/>.</summary>
    public SinterOptions Skip(string resource)
    {
        Skips.Add(resource);
        return this;
    }

    /// <summary>Middleware for in-process API requests, after routing, CORS, authentication and authorization, before the endpoint.</summary>
    public SinterOptions ConfigureApi(Action<IApplicationBuilder> configure)
    {
        ApiMiddleware.Add(configure);
        return this;
    }
}
