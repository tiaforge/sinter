// The app's own endpoints (minimal APIs, MVC controllers, anything endpoint routing serves), called
// in-process: a request of its own, through routing, CORS, authentication and authorization, with the
// page request's forwarded headers, its own service scope, and its response captured in memory.
using System.IO.Pipelines;
using Microsoft.AspNetCore.Authentication;
using Microsoft.AspNetCore.Authorization.Policy;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Cors.Infrastructure;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Http.Features;
using Microsoft.AspNetCore.Routing;
using Microsoft.Extensions.DependencyInjection;

namespace Sinter.AspNetCore;

internal sealed class InProcessApi(IApplicationBuilder app, IReadOnlyList<Action<IApplicationBuilder>> middleware)
{
    // how endpoint routing finds the app's endpoints in a pipeline of its own (as WebApplication does)
    private const string GlobalRoutes = "__GlobalEndpointRouteBuilder";

    private readonly IServiceScopeFactory _scopes = app.ApplicationServices.GetRequiredService<IServiceScopeFactory>();
    private RequestDelegate? _pipeline;
    private readonly object _lock = new();

    /// <summary>
    /// Built on the first request, when every endpoint is mapped: <c>MapGet</c> and <c>MapControllers</c>
    /// can come after <c>UseSinter</c>.
    /// </summary>
    private RequestDelegate Pipeline()
    {
        if (_pipeline is { } p) return p;
        lock (_lock)
        {
            if (_pipeline is not null) return _pipeline;
            var services = app.ApplicationServices;
            var b = app.New();
            b.Properties[GlobalRoutes] = new Routes(services, b);
            b.UseRouting();
            if (services.GetService<ICorsService>() is not null) b.UseCors();
            if (services.GetService<IAuthenticationSchemeProvider>() is not null) b.UseAuthentication();
            if (services.GetService<IPolicyEvaluator>() is not null) b.UseAuthorization();
            foreach (var m in middleware) m(b);
            b.Run(static ctx =>
            {
                if (ctx.GetEndpoint()?.RequestDelegate is { } d) return d(ctx);
                ctx.Response.StatusCode = StatusCodes.Status404NotFound;
                return Task.CompletedTask;
            });
            return _pipeline = b.Build();
        }
    }

    /// <summary>The body of a 2xx JSON response within <paramref name="max"/> bytes, else why not.</summary>
    public async Task<(ReadOnlyMemory<byte>?, string?)> GetAsync(HttpContext page, string url, string[] forward, int max, CancellationToken ct, KeyValuePair<string, string>[]? own = null)
    {
        var features = new FeatureCollection();
        var (path, query) = SplitUrl(url);
        var request = new HttpRequestFeature
        {
            Protocol = page.Request.Protocol,
            Scheme = page.Request.Scheme,
            Method = HttpMethods.Get,
            RawTarget = url,
            Body = Stream.Null,
        };
        // the page's PathBase, when the app is mounted under one (UsePathBase)
        var pathBase = page.Request.PathBase;
        var p = PathString.FromUriComponent(path);
        if (pathBase.HasValue && p.StartsWithSegments(pathBase, out var rest)) { request.PathBase = pathBase.Value!; request.Path = rest.Value ?? "/"; }
        else request.Path = p.Value ?? "/";
        request.QueryString = query;
        var headers = request.Headers;
        headers.Host = page.Request.Headers.Host;
        foreach (var n in forward)
            if (page.Request.Headers.TryGetValue(n, out var v)) headers[n] = v;
        // the API's static headers (`sinter({ apis })`) the request does not have already
        foreach (var (k, v) in own ?? [])
            if (!headers.ContainsKey(k)) headers[k] = v;
        headers.Accept = "application/json";
        features.Set<IHttpRequestFeature>(request);
        var response = new CapturedResponse(max);
        features.Set<IHttpResponseFeature>(response);
        features.Set<IHttpResponseBodyFeature>(response);
        features.Set<IHttpRequestLifetimeFeature>(new HttpRequestLifetimeFeature { RequestAborted = ct });
        features.Set<IHttpRequestIdentifierFeature>(new HttpRequestIdentifierFeature());
        if (page.Features.Get<IHttpConnectionFeature>() is { } conn) features.Set(conn);
        if (page.Features.Get<ITlsConnectionFeature>() is { } tls) features.Set(tls);
        var ctx = new DefaultHttpContext(features);
        await using var scope = new RequestServicesFeature(ctx, _scopes);
        features.Set<IServiceProvidersFeature>(scope);
        // the page's user, for authentication done outside this pipeline (a certificate, Windows); the
        // forwarded cookie or token authenticates again here
        ctx.User = page.User;
        try
        {
            await Pipeline()(ctx).ConfigureAwait(false);
            await response.CompleteAsync().ConfigureAwait(false);
        }
        catch (CapturedResponse.TooLarge)
        {
            return (null, $"over {max} bytes");
        }
        catch (Exception e) when (e is not OperationCanceledException)
        {
            return (null, $"the endpoint threw {e.GetType().Name}: {e.Message}");
        }
        finally
        {
            await response.RunCompletedAsync().ConfigureAwait(false);
        }
        if (response.StatusCode is < 200 or > 299) return (null, $"status {response.StatusCode}");
        if (!SinterEngine.IsJson(response.Headers.ContentType)) return (null, "not JSON");
        return (response.Body, null);
    }

    private static (string Path, string Query) SplitUrl(string url)
    {
        var h = url.IndexOf('#');
        if (h >= 0) url = url[..h];
        var q = url.IndexOf('?');
        return q >= 0 ? (url[..q], url[q..]) : (url, "");
    }

    /// <summary>The app's endpoints: every data source it registered (the same set its own routing uses).</summary>
    private sealed class Routes(IServiceProvider services, IApplicationBuilder builder) : IEndpointRouteBuilder
    {
        public IServiceProvider ServiceProvider { get; } = services;
        public ICollection<EndpointDataSource> DataSources { get; } = [services.GetRequiredService<EndpointDataSource>()];
        public IApplicationBuilder CreateApplicationBuilder() => builder.New();
    }

    /// <summary>A response held in memory: its status, headers and body, up to a limit.</summary>
    private sealed class CapturedResponse(int max) : Stream, IHttpResponseFeature, IHttpResponseBodyFeature
    {
        public sealed class TooLarge : Exception;

        private byte[] _buf = new byte[4096];
        private int _len;
        private PipeWriter? _writer;
        private List<(Func<object, Task>, object)>? _starting, _completed;

        public ReadOnlyMemory<byte> Body => _buf.AsMemory(0, _len);

        // IHttpResponseFeature
        public int StatusCode { get; set; } = 200;
        public string? ReasonPhrase { get; set; }
        public IHeaderDictionary Headers { get; set; } = new HeaderDictionary();
        Stream IHttpResponseFeature.Body { get => this; set => throw new NotSupportedException(); }
        public bool HasStarted { get; private set; }
        public void OnStarting(Func<object, Task> callback, object state)
        {
            if (HasStarted) throw new InvalidOperationException("The response has started.");
            (_starting ??= []).Add((callback, state));
        }
        public void OnCompleted(Func<object, Task> callback, object state) => (_completed ??= []).Add((callback, state));

        // IHttpResponseBodyFeature
        Stream IHttpResponseBodyFeature.Stream => this;
        public PipeWriter Writer => _writer ??= PipeWriter.Create(this, new StreamPipeWriterOptions(leaveOpen: true));
        public void DisableBuffering() { }
        public async Task StartAsync(CancellationToken cancellationToken = default)
        {
            if (HasStarted) return;
            HasStarted = true;
            if (_starting is null) return;
            // last registered first, as servers run them
            for (var i = _starting.Count - 1; i >= 0; i--) await _starting[i].Item1(_starting[i].Item2).ConfigureAwait(false);
        }
        public async Task SendFileAsync(string path, long offset, long? count, CancellationToken cancellationToken = default)
        {
            await StartAsync(cancellationToken).ConfigureAwait(false);
            await SendFileFallback.SendFileAsync(this, path, offset, count, cancellationToken).ConfigureAwait(false);
        }
        public async Task CompleteAsync()
        {
            if (_writer is not null) await _writer.FlushAsync().ConfigureAwait(false);
            await StartAsync().ConfigureAwait(false);
        }
        public async Task RunCompletedAsync()
        {
            if (_completed is null) return;
            for (var i = _completed.Count - 1; i >= 0; i--)
            {
                try { await _completed[i].Item1(_completed[i].Item2).ConfigureAwait(false); }
                catch (Exception) { /* as a server does: a completion callback's failure is not the response's */ }
            }
        }

        // Stream: the body
        public override bool CanRead => false;
        public override bool CanSeek => false;
        public override bool CanWrite => true;
        public override long Length => _len;
        public override long Position { get => _len; set => throw new NotSupportedException(); }
        public override void Flush() { }
        public override Task FlushAsync(CancellationToken cancellationToken) => Task.CompletedTask;
        public override int Read(byte[] buffer, int offset, int count) => throw new NotSupportedException();
        public override long Seek(long offset, SeekOrigin origin) => throw new NotSupportedException();
        public override void SetLength(long value) => throw new NotSupportedException();
        public override void Write(byte[] buffer, int offset, int count) => Write(buffer.AsSpan(offset, count));
        public override void Write(ReadOnlySpan<byte> buffer)
        {
            if (!HasStarted) StartAsync().GetAwaiter().GetResult();
            Append(buffer);
        }
        public override Task WriteAsync(byte[] buffer, int offset, int count, CancellationToken cancellationToken) =>
            WriteAsync(buffer.AsMemory(offset, count), cancellationToken).AsTask();
        public override async ValueTask WriteAsync(ReadOnlyMemory<byte> buffer, CancellationToken cancellationToken = default)
        {
            if (!HasStarted) await StartAsync(cancellationToken).ConfigureAwait(false);
            Append(buffer.Span);
        }

        private void Append(ReadOnlySpan<byte> data)
        {
            if ((long)_len + data.Length > max) throw new TooLarge();
            if (_len + data.Length > _buf.Length) Array.Resize(ref _buf, Math.Min(Math.Max(_buf.Length * 2, _len + data.Length), Math.Max(max, _len + data.Length)));
            data.CopyTo(_buf.AsSpan(_len));
            _len += data.Length;
        }
    }
}
