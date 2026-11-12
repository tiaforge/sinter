using System.ComponentModel;
using Sinter.AspNetCore.Manifest;

namespace Sinter.AspNetCore;

/// <summary>
/// Compiles the build named by <c>&lt;SinterBuild&gt;</c> in the project file into this class, and checks
/// it when the project compiles: a placeholder without a request the build describes needs a
/// <see cref="SinterResolveAttribute"/> method or a <see cref="SinterSkipAttribute"/>, and a name no
/// placeholder has is an error. The class gets a static <c>Build</c> property for <c>AddSinter</c>.
/// </summary>
/// <example>
/// <code>
/// [SinterEmbed, SinterSkip("user")]
/// static partial class Web
/// {
///     [SinterResolve("profile.html:articles")]
///     static Task&lt;ArticleList?&gt; Articles(SlotRequest req, ArticleStore store) => store.ByAuthor(req.Param("username"));
/// }
///
/// builder.Services.AddSinter(Web.Build);
/// </code>
/// </example>
[AttributeUsage(AttributeTargets.Class, Inherited = false)]
public sealed class SinterEmbedAttribute : Attribute;

/// <summary>
/// A static method that gives a resource's data. <c>"articles"</c> applies to every page,
/// <c>"profile.html:articles"</c> to one. Its parameters are bound when the project compiles:
/// <see cref="SlotRequest"/>, <c>HttpContext</c>, <c>CancellationToken</c>, <c>ClaimsPrincipal</c>,
/// <c>IServiceProvider</c>, or any other type from the placeholder's service scope. It returns (or
/// returns a <c>Task</c> or <c>ValueTask</c> of) a <c>byte[]</c> or <c>string</c> of JSON, a
/// <see cref="SlotData"/>, or any value, serialized as minimal APIs serialize it; null leaves the
/// resource to the browser.
/// </summary>
[AttributeUsage(AttributeTargets.Method, Inherited = false)]
public sealed class SinterResolveAttribute(string resource) : Attribute
{
    /// <summary>The resource, or <c>page.html:resource</c>.</summary>
    public string Resource { get; } = resource;
}

/// <summary>A resource the server does not fill: the browser requests it. Names as for <see cref="SinterResolveAttribute"/>.</summary>
[AttributeUsage(AttributeTargets.Class, AllowMultiple = true, Inherited = false)]
public sealed class SinterSkipAttribute(params string[] resources) : Attribute
{
    /// <summary>The resources.</summary>
    public string[] Resources { get; } = resources;
}

/// <summary>A build compiled in by [SinterEmbed]: its manifest, where it was, and its resolvers and skips.</summary>
public sealed class SinterCompiledBuild
{
    private SinterCompiledBuild(SinterManifest manifest, ulong fingerprint, string dir, Action<SinterOptions> configure)
    {
        Manifest = manifest;
        Fingerprint = fingerprint;
        Dir = dir;
        Configure = configure;
    }

    internal SinterManifest Manifest { get; }
    internal ulong Fingerprint { get; }
    /// <summary>The build's directory when the project compiled.</summary>
    public string Dir { get; }
    internal Action<SinterOptions> Configure { get; }

    /// <summary>For generated code.</summary>
    [EditorBrowsable(EditorBrowsableState.Never)]
    public static SinterCompiledBuild Create(SinterManifest manifest, ulong fingerprint, string dir, Action<SinterOptions> configure) =>
        new(manifest, fingerprint, dir, configure);
}

/// <summary>A build or a configuration the middleware cannot use; every problem is in the message, one line each.</summary>
public sealed class SinterException(string message) : Exception("Sinter.AspNetCore: " + message)
{
    /// <summary>The message without the package's name.</summary>
    public string Detail { get; } = message;
}
