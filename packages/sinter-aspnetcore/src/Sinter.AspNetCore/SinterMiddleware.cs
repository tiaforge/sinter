using System.Buffers;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Http.Features;
using Microsoft.Net.Http.Headers;
using Sinter.AspNetCore.Manifest;

namespace Sinter.AspNetCore;

/// <summary>
/// Answers a sinter build's pages with their data written in, and follows the build's URL rules
/// (redirects, rewrites, the visitor's language). Everything else goes to the next middleware.
/// </summary>
internal sealed class SinterMiddleware(RequestDelegate next, SinterEngine engine)
{
    public Task InvokeAsync(HttpContext ctx)
    {
        var req = ctx.Request;
        var head = HttpMethods.IsHead(req.Method);
        if (!head && !HttpMethods.IsGet(req.Method)) return next(ctx);
        var path = req.Path.Value is { Length: > 0 } v ? v : "/";
        // the manifest describes the app's requests; it is not a page
        if (path == "/" + ManifestReader.File)
        {
            ctx.Response.StatusCode = StatusCodes.Status404NotFound;
            return Task.CompletedTask;
        }
        var route = engine.Route(path);
        // an unprefixed URL of a site with languages: to the visitor's (the `locale` cookie the pages set, else
        // Accept-Language, else the base), the page's path under its prefix (a fixed rule's target: `/about.html`
        // goes straight to `/de/about/`; a pattern's, the request's); temporary, as it differs per visitor
        if (engine.Locales is { } l && route is { Choose: true } r)
        {
            var lang = Choose(l, req.Headers);
            var p = r.From.AsSpan().IndexOfAny(':', '*') >= 0 ? req.Path.ToUriComponent() : r.To;
            var rest = p.StartsWith(l.At, StringComparison.Ordinal) ? p[l.At.Length..] : p.TrimStart('/');
            ctx.Response.StatusCode = StatusCodes.Status302Found;
            ctx.Response.Headers.Location = $"{l.At}{lang}/{rest}{req.QueryString}";
            ctx.Response.Headers.Vary = "Cookie, Accept-Language";
            return Task.CompletedTask;
        }
        // an old file URL: a permanent redirect to the page's URL, with the query
        if (route is { Status: not 200 })
        {
            ctx.Response.StatusCode = route.Status is >= 300 and < 400 ? route.Status : StatusCodes.Status301MovedPermanently;
            ctx.Response.Headers.Location = route.To + req.QueryString;
            return Task.CompletedTask;
        }
        var page = engine.Page(path);
        if (page >= 0) return Render(ctx, engine.Pages[page], head);
        // a path a page declares, for a page without embedded data: its file, as a host's rewrite serves it
        if (route is { File: { } file })
        {
            req.Path = "/" + file;
            // routing may have chosen an endpoint for the old path
            ctx.SetEndpoint(null);
            ctx.Request.RouteValues.Clear();
        }
        return next(ctx);
    }

    /// <summary>The visitor's language among the site's: the <c>locale</c> cookie the pages record, else the first of <c>Accept-Language</c> the site has (<c>de-AT</c> is <c>de</c>), else the base.</summary>
    internal static string Choose(ManifestLocales l, IHeaderDictionary h)
    {
        string? Find(string x)
        {
            x = x.Trim();
            foreach (var c in l.List)
                if (string.Equals(c, x, StringComparison.OrdinalIgnoreCase)) return c;
            var dash = x.IndexOf('-');
            var primary = dash >= 0 ? x[..dash] : x;
            foreach (var c in l.List)
                if (string.Equals(c, primary, StringComparison.OrdinalIgnoreCase)) return c;
            return null;
        }
        foreach (var header in h.Cookie)
            foreach (var c in (header ?? "").Split(';'))
                if (c.Trim() is var t && t.StartsWith("locale=", StringComparison.Ordinal) && Find(t["locale=".Length..]) is { } lang)
                    return lang;
        if (h.AcceptLanguage.ToString() is { Length: > 0 } al)
            foreach (var part in al.Split(','))
                if (Find(part.Split(';')[0]) is { } lang)
                    return lang;
        return l.Base;
    }

    private async Task Render(HttpContext ctx, Page page, bool head)
    {
        var o = engine.Options;
        var res = ctx.Response;
        res.StatusCode = StatusCodes.Status200OK;
        res.ContentType = "text/html; charset=utf-8";
        res.Headers.CacheControl = o.CacheControl;
        if (head) return;
        var p = SinterUrl.UrlParams(ctx.Request.Path.Value ?? "/", ctx.Request.QueryString.Value, page.Paths);
        using var cts = CancellationTokenSource.CreateLinkedTokenSource(ctx.RequestAborted);
        using var deadline = new CancellationTokenSource(o.Timeout);
        using var both = CancellationTokenSource.CreateLinkedTokenSource(cts.Token, deadline.Token);
        var started = TimeProvider.System.GetTimestamp();
        var slots = page.Slots;
        var requests = new SlotRequest[slots.Length];
        var fills = new Task<Fill>[slots.Length];
        for (var i = 0; i < slots.Length; i++)
        {
            var s = slots[i];
            requests[i] = new SlotRequest(ctx, page.File, s.Resource, SinterEngine.DescribedUrl(s, p), p, both.Token, s.Headers);
            fills[i] = engine.FillAsync(requests[i]);
        }
        try
        {
            if (o.Stream) await Stream(ctx, page, fills, started).ConfigureAwait(false);
            else await Whole(ctx, page, fills, started).ConfigureAwait(false);
        }
        finally
        {
            // the page is out (or ended early): stop whatever is still fetching
            await cts.CancelAsync().ConfigureAwait(false);
            for (var i = 0; i < fills.Length; i++)
            {
                var fill = fills[i];
                var r = requests[i];
                if (fill.IsCompleted) await r.DisposeAsync().ConfigureAwait(false);
                else _ = fill.ContinueWith(static (_, x) => ((SlotRequest)x!).DisposeAsync(), r, CancellationToken.None, TaskContinuationOptions.ExecuteSynchronously, TaskScheduler.Default);
            }
        }
    }

    /// <summary>A placeholder's fill, or 504 when the page's time limit passes first (a resolver that ignores its token does not hold the page).</summary>
    private async ValueTask<Fill> Wait(Task<Fill> fill, long started)
    {
        if (fill.IsCompletedSuccessfully) return fill.Result;
        var left = engine.Options.Timeout - TimeProvider.System.GetElapsedTime(started);
        if (left <= TimeSpan.Zero) return Fill.Failed(StatusCodes.Status504GatewayTimeout);
        try { return await fill.WaitAsync(left).ConfigureAwait(false); }
        catch (TimeoutException) { return Fill.Failed(StatusCodes.Status504GatewayTimeout); }
    }

    /// <summary>
    /// The head up to the first placeholder at once; the rest as the data comes in, in order. A failed
    /// placeholder ends the page there: still in the head, inside that placeholder's <c>&lt;script&gt;</c>.
    /// </summary>
    private async Task Stream(HttpContext ctx, Page page, Task<Fill>[] fills, long started)
    {
        ctx.Features.Get<IHttpResponseBodyFeature>()?.DisableBuffering();
        var w = ctx.Response.BodyWriter;
        w.Write(page.Parts[0]);
        // what is written goes out when the next placeholder's data is not in yet: what is ready is sent
        // together (one write, and with compression one flush), and nothing waits behind data still to come
        if (fills.Length > 0 && !fills[0].IsCompleted) await w.FlushAsync(ctx.RequestAborted).ConfigureAwait(false);
        for (var i = 0; i < fills.Length; i++)
        {
            var fill = await Wait(fills[i], started).ConfigureAwait(false);
            if (fill.What == Fill.Kind.Failed)
            {
                w.Write(engine.StreamTail);
                await w.FlushAsync(ctx.RequestAborted).ConfigureAwait(false);
                return;
            }
            if (fill.What == Fill.Kind.Data) SinterUrl.WriteEscaped(w, fill.Data.Span);
            w.Write(page.Parts[i + 1]);
            if (i + 1 == fills.Length || !fills[i + 1].IsCompleted) await w.FlushAsync(ctx.RequestAborted).ConfigureAwait(false);
        }
    }

    /// <summary>In one piece: the response waits for the data, and a failure is its status.</summary>
    private async Task Whole(HttpContext ctx, Page page, Task<Fill>[] fills, long started)
    {
        var done = new Fill[fills.Length];
        for (var i = 0; i < fills.Length; i++) done[i] = await Wait(fills[i], started).ConfigureAwait(false);
        foreach (var f in done)
        {
            if (f.What != Fill.Kind.Failed) continue;
            ctx.Response.StatusCode = f.Status;
            ctx.Response.ContentLength = engine.ErrorDocument.Length;
            await ctx.Response.Body.WriteAsync(engine.ErrorDocument, ctx.RequestAborted).ConfigureAwait(false);
            return;
        }
        var out_ = new ArrayBufferWriter<byte>(page.Length + done.Sum(f => f.Data.Length) + 64);
        out_.Write(page.Parts[0]);
        for (var i = 0; i < done.Length; i++)
        {
            if (done[i].What == Fill.Kind.Data) SinterUrl.WriteEscaped(out_, done[i].Data.Span);
            out_.Write(page.Parts[i + 1]);
        }
        ctx.Response.ContentLength = out_.WrittenCount;
        await ctx.Response.Body.WriteAsync(out_.WrittenMemory, ctx.RequestAborted).ConfigureAwait(false);
    }
}
