// [SinterEmbed]: compiles a sinter build's sinter-embed.json into the class (no manifest parsing at
// startup, no reflection), checks its placeholders against the class's [SinterResolve] methods and
// [SinterSkip] names when the project compiles, and binds each resolver's parameters in code.
using System;
using System.Collections.Generic;
using System.Collections.Immutable;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Text;
using System.Threading;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;
using Microsoft.CodeAnalysis.Text;

namespace Sinter.AspNetCore.Generator;

[Generator(LanguageNames.CSharp)]
public sealed class SinterGenerator : IIncrementalGenerator
{
    private const string Embed = "Sinter.AspNetCore.SinterEmbedAttribute";
    private const string ResolveAttr = "Sinter.AspNetCore.SinterResolveAttribute";
    private const string SkipAttr = "Sinter.AspNetCore.SinterSkipAttribute";
    private const string ManifestFile = "sinter-embed.json";

    private static DiagnosticDescriptor D(int n, string title, string format) =>
        new($"SINTER{n:000}", title, format, "Sinter", DiagnosticSeverity.Error, isEnabledByDefault: true);

    internal static readonly DiagnosticDescriptor NoBuild = D(1, "The sinter build is not there", "{0}");
    internal static readonly DiagnosticDescriptor BadManifest = D(2, "The sinter build's manifest cannot be read", "{0}: {1}");
    internal static readonly DiagnosticDescriptor NoSource = D(3, "A placeholder has no source", "{0}: `{1}`: {2}. Add [SinterResolve(\"{1}\")] to a method that gives its data, or [SinterSkip(\"{1}\")] to leave it to the browser.");
    internal static readonly DiagnosticDescriptor Unknown = D(4, "No placeholder has this name", "no page of the build has a placeholder for `{0}` (it has {1})");
    internal static readonly DiagnosticDescriptor NotStatic = D(5, "A resolver must be static", "[SinterResolve] method `{0}` must be static and not generic");
    internal static readonly DiagnosticDescriptor BadReturn = D(6, "A resolver must return data", "[SinterResolve] method `{0}` returns {1}: return (a Task or ValueTask of) a byte[] or string of JSON, a SlotData, or a value to serialize");
    internal static readonly DiagnosticDescriptor NotPartial = D(7, "[SinterEmbed] needs a partial class", "[SinterEmbed] class `{0}` (and the types it is nested in) must be partial and not generic");

    public void Initialize(IncrementalGeneratorInitializationContext context)
    {
        var classes = context.SyntaxProvider.ForAttributeWithMetadataName(Embed,
            static (n, _) => n is TypeDeclarationSyntax,
            static (ctx, ct) => Model(ctx, ct));
        var manifests = context.AdditionalTextsProvider
            .Where(static t => string.Equals(Path.GetFileName(t.Path), ManifestFile, StringComparison.OrdinalIgnoreCase))
            .Select(static (t, ct) => new FileText(t.Path, t.GetText(ct)?.ToString()))
            .Collect();
        var props = context.AnalyzerConfigOptionsProvider.Select(static (p, _) =>
        {
            p.GlobalOptions.TryGetValue("build_property.SinterBuild", out var build);
            p.GlobalOptions.TryGetValue("build_property.SinterBuildDir", out var dir);
            return new Props(string.IsNullOrEmpty(build) ? null : build, string.IsNullOrEmpty(dir) ? null : dir);
        });
        context.RegisterSourceOutput(classes.Combine(manifests.Combine(props)), static (spc, x) => Emit(spc, x.Left, x.Right.Left, x.Right.Right));
    }

    // the models: plain values, so that the generator's steps cache

    internal sealed record FileText(string Path, string? Text);
    internal sealed record Props(string? Build, string? Dir);
    internal sealed record Loc(string File, TextSpan Span, LinePositionSpan Lines)
    {
        public static Loc? Of(Location? l) => l is null || l.SourceTree is null ? null : new(l.SourceTree.FilePath, l.SourceSpan, l.GetLineSpan().Span);
        public Location ToLocation() => Location.Create(File, Span, Lines);
    }
    internal sealed record Skip(string Name, Loc? At);
    internal sealed record Resolver(string Name, Loc? At, string Method, Loc? MethodAt, string? Call, string? Error, string? ErrorArg);
    internal sealed record ClassModel(
        string? Namespace, Eq<string> Containers, string Keyword, string Name, bool Ok, Loc? At,
        Eq<Skip> Skips, Eq<Resolver> Resolvers);

    /// <summary>An array with value equality.</summary>
    internal readonly struct Eq<T>(ImmutableArray<T> items) : IEquatable<Eq<T>>
    {
        public ImmutableArray<T> Items => items.IsDefault ? ImmutableArray<T>.Empty : items;
        public bool Equals(Eq<T> o) => Items.SequenceEqual(o.Items);
        public override bool Equals(object? o) => o is Eq<T> e && Equals(e);
        public override int GetHashCode() => Items.Aggregate(17, (h, x) => h * 31 + (x?.GetHashCode() ?? 0));
    }

    private static ClassModel Model(GeneratorAttributeSyntaxContext ctx, CancellationToken ct)
    {
        var type = (INamedTypeSymbol)ctx.TargetSymbol;
        var decl = (TypeDeclarationSyntax)ctx.TargetNode;
        var ok = decl.Modifiers.Any(SyntaxKind.PartialKeyword) && type.TypeParameters.Length == 0;
        var containers = new List<string>();
        for (var c = type.ContainingType; c is not null; c = c.ContainingType)
        {
            var cd = c.DeclaringSyntaxReferences.FirstOrDefault()?.GetSyntax(ct) as TypeDeclarationSyntax;
            ok &= cd is not null && cd.Modifiers.Any(SyntaxKind.PartialKeyword) && c.TypeParameters.Length == 0;
            containers.Insert(0, $"partial {Keyword(cd)} {c.Name}");
        }
        var skips = new List<Skip>();
        foreach (var a in type.GetAttributes())
        {
            if (a.AttributeClass?.ToDisplayString() != SkipAttr) continue;
            var syntax = a.ApplicationSyntaxReference?.GetSyntax(ct) as AttributeSyntax;
            var args = syntax?.ArgumentList?.Arguments;
            var values = a.ConstructorArguments.FirstOrDefault();
            if (values.Kind != TypedConstantKind.Array) continue;
            for (var i = 0; i < values.Values.Length; i++)
                if (values.Values[i].Value is string s)
                    skips.Add(new Skip(s, Loc.Of(args is { } l && i < l.Count ? l[i].GetLocation() : syntax?.GetLocation())));
        }
        var resolvers = new List<Resolver>();
        foreach (var m in type.GetMembers().OfType<IMethodSymbol>())
            foreach (var a in m.GetAttributes())
            {
                if (a.AttributeClass?.ToDisplayString() != ResolveAttr || a.ConstructorArguments.FirstOrDefault().Value is not string name) continue;
                var syntax = a.ApplicationSyntaxReference?.GetSyntax(ct) as AttributeSyntax;
                var at = Loc.Of(syntax?.ArgumentList?.Arguments.FirstOrDefault()?.GetLocation() ?? syntax?.GetLocation());
                var mat = Loc.Of(m.Locations.FirstOrDefault());
                if (!m.IsStatic || m.IsGenericMethod)
                {
                    resolvers.Add(new Resolver(name, at, m.Name, mat, null, "static", null));
                    continue;
                }
                var (call, bad) = Bind(type, m);
                resolvers.Add(new Resolver(name, at, m.Name, mat, call, bad is null ? null : "return", bad));
            }
        return new ClassModel(
            type.ContainingNamespace.IsGlobalNamespace ? null : type.ContainingNamespace.ToDisplayString(),
            new Eq<string>(containers.ToImmutableArray()), Keyword(decl), type.Name, ok, Loc.Of(decl.Identifier.GetLocation()),
            new Eq<Skip>(skips.ToImmutableArray()), new Eq<Resolver>(resolvers.ToImmutableArray()));
    }

    private static string Keyword(TypeDeclarationSyntax? d) => d switch
    {
        RecordDeclarationSyntax r when r.ClassOrStructKeyword.IsKind(SyntaxKind.StructKeyword) => "record struct",
        RecordDeclarationSyntax => "record",
        StructDeclarationSyntax => "struct",
        _ => "class",
    };

    private const string Ns = "global::Sinter.AspNetCore.";

    /// <summary>A resolver lambda for the method: its parameters bound, its result as SlotData; or what is wrong with its return type.</summary>
    private static (string? Call, string? Bad) Bind(INamedTypeSymbol owner, IMethodSymbol m)
    {
        var args = m.Parameters.Select(p => Arg(p)).ToArray();
        var invoke = $"{owner.Name}.{m.Name}({string.Join(", ", args)})";
        var ret = m.ReturnType;
        var awaited = false;
        if (ret is INamedTypeSymbol { IsGenericType: true } g)
        {
            var def = g.OriginalDefinition.ToDisplayString();
            if (def is "System.Threading.Tasks.Task<TResult>" or "System.Threading.Tasks.ValueTask<TResult>")
            {
                ret = g.TypeArguments[0];
                awaited = true;
            }
        }
        var name = ret.ToDisplayString();
        if (m.ReturnsVoid || name is "System.Threading.Tasks.Task" or "System.Threading.Tasks.ValueTask")
            return (null, m.ReturnsVoid ? "nothing" : "no data");
        var value = awaited ? $"await {invoke}.ConfigureAwait(false)" : invoke;
        var bare = ret.WithNullableAnnotation(NullableAnnotation.NotAnnotated).ToDisplayString(SymbolDisplayFormat.FullyQualifiedFormat);
        var wrap = bare switch
        {
            "byte[]" or "string" or Ns + "SlotData" => $"{Ns}SlotData.From({value})",
            "global::System.ReadOnlyMemory<byte>" => $"{Ns}SlotData.From((global::System.ReadOnlyMemory<byte>?)({value}))",
            _ when ret.SpecialType == SpecialType.System_Object => null,
            _ => $"{Ns}SlotData.Serialize<{bare}>({value}, r)",
        };
        if (wrap is null) return (null, "object (its type must be known to serialize it)");
        return awaited
            ? ($"({Ns}SlotResolver)(static async r => {wrap})", null)
            : ($"({Ns}SlotResolver)(static r => new global::System.Threading.Tasks.ValueTask<{Ns}SlotData>({wrap}))", null);
    }

    private static string Arg(IParameterSymbol p)
    {
        var t = p.Type.WithNullableAnnotation(NullableAnnotation.NotAnnotated).ToDisplayString(SymbolDisplayFormat.FullyQualifiedFormat);
        return t switch
        {
            Ns + "SlotRequest" => "r",
            "global::Microsoft.AspNetCore.Http.HttpContext" => "r.HttpContext",
            "global::System.Threading.CancellationToken" => "r.Cancellation",
            "global::System.Security.Claims.ClaimsPrincipal" => "r.User",
            "global::System.IServiceProvider" => "r.Services",
            "global::Microsoft.AspNetCore.Http.IHeaderDictionary" => "r.Headers",
            _ when p.NullableAnnotation == NullableAnnotation.Annotated && p.Type.IsReferenceType =>
                $"(({t}?)r.Services.GetService(typeof({t})))",
            _ => $"global::Microsoft.Extensions.DependencyInjection.ServiceProviderServiceExtensions.GetRequiredService<{t}>(r.Services)",
        };
    }

    // emitting

    private sealed class Slot(string page, string resource, string? undescribed)
    {
        public string Page = page, Resource = resource;
        public string? Undescribed = undescribed;
    }

    private static void Emit(SourceProductionContext spc, ClassModel c, ImmutableArray<FileText> files, Props props)
    {
        var at = c.At?.ToLocation();
        if (!c.Ok)
        {
            spc.ReportDiagnostic(Diagnostic.Create(NotPartial, at, c.Name));
            return;
        }
        if (props.Build is null || props.Dir is null)
        {
            spc.ReportDiagnostic(Diagnostic.Create(NoBuild, at,
                "[SinterEmbed] needs the sinter build's output directory: add <SinterBuild>../web/dist</SinterBuild> (relative to the project) to the project file"));
            return;
        }
        var want = Path.Combine(props.Dir, ManifestFile);
        var file = files.FirstOrDefault(f => SamePath(f.Path, want));
        if (file?.Text is not { } text)
        {
            spc.ReportDiagnostic(Diagnostic.Create(NoBuild, at, $"{want}: not found. Build the frontend first, with `sinter({{ embed: true }})`"));
            return;
        }
        object? manifest;
        List<Slot> slots;
        try
        {
            manifest = Json.Parse(text);
            slots = Slots(manifest);
        }
        catch (Exception e) when (e is JsonException or InvalidCastException or KeyNotFoundException or NullReferenceException)
        {
            spc.ReportDiagnostic(Diagnostic.Create(BadManifest, at, want, e is JsonException ? e.Message : "not a sinter-embed.json of version 2"));
            return;
        }
        var ok = true;
        // a name no placeholder has (a typo)
        var names = new SortedSet<string>(slots.Select(s => $"`{s.Resource}`"), StringComparer.Ordinal);
        foreach (var (name, loc) in c.Skips.Items.Select(s => (s.Name, s.At)).Concat(c.Resolvers.Items.Select(r => (r.Name, r.At))))
            if (!slots.Any(s => s.Resource == name || $"{s.Page}:{s.Resource}" == name))
            {
                spc.ReportDiagnostic(Diagnostic.Create(Unknown, loc?.ToLocation() ?? at, name, string.Join(", ", names)));
                ok = false;
            }
        foreach (var r in c.Resolvers.Items)
        {
            if (r.Error == "static") { spc.ReportDiagnostic(Diagnostic.Create(NotStatic, r.MethodAt?.ToLocation() ?? at, r.Method)); ok = false; }
            else if (r.Error == "return") { spc.ReportDiagnostic(Diagnostic.Create(BadReturn, r.MethodAt?.ToLocation() ?? at, r.Method, r.ErrorArg)); ok = false; }
        }
        // a placeholder without a request the build describes, and no entry
        bool Covered(Slot s) => c.Skips.Items.Any(k => k.Name == s.Resource || k.Name == $"{s.Page}:{s.Resource}")
            || c.Resolvers.Items.Any(k => k.Name == s.Resource || k.Name == $"{s.Page}:{s.Resource}");
        foreach (var s in slots)
            if (s.Undescribed is { } why && !Covered(s))
            {
                spc.ReportDiagnostic(Diagnostic.Create(NoSource, at, s.Page, s.Resource, why));
                ok = false;
            }
        if (!ok) return;
        spc.AddSource($"{string.Join(".", c.Containers.Items.Select(x => x.Split(' ').Last()).Concat([c.Name]))}.Sinter.g.cs",
            Source(c, manifest, Fingerprint(text), props.Build));
    }

    private static bool SamePath(string a, string b)
    {
        try { return string.Equals(Path.GetFullPath(a), Path.GetFullPath(b), StringComparison.OrdinalIgnoreCase); }
        catch (Exception e) when (e is ArgumentException or NotSupportedException or PathTooLongException) { return false; }
    }

    private static List<Slot> Slots(object? m)
    {
        var root = (Dictionary<string, object?>)m!;
        if (!root.TryGetValue("version", out var v) || v is not double d || d != 2) throw new InvalidCastException();
        var o = new List<Slot>();
        foreach (var p in Objs(root["pages"]!))
        {
            var page = (string)p["file"]!;
            foreach (var s in Objs(p["data"]!))
            {
                string? why = null;
                if (!s.TryGetValue("src", out var src) || src is null)
                    why = "the build could not describe its request (its `src` calls a helper, or reads something other than `$url`)";
                else if (s.TryGetValue("when", out var w) && w is true)
                    why = "its `when` is a condition only the browser can evaluate";
                o.Add(new Slot(page, (string)s["resource"]!, why));
            }
        }
        return o;
    }

    /// <summary>FNV-1a (64 bits) over the manifest's text, as the middleware computes it at startup (ManifestReader.Fingerprint).</summary>
    internal static ulong Fingerprint(string text)
    {
        var h = 14695981039346656037UL;
        var i = text.Length > 0 && text[0] == '\uFEFF' ? 1 : 0;
        for (; i < text.Length; i++)
        {
            var c = text[i];
            if (c == '\r') continue;
            h = (h ^ c) * 1099511628211UL;
        }
        return h;
    }

    private const string M = "global::Sinter.AspNetCore.Manifest.";

    private static string Source(ClassModel c, object? manifest, ulong fingerprint, string dir)
    {
        var root = (Dictionary<string, object?>)manifest!;
        var b = new StringBuilder();
        b.AppendLine("// <auto-generated/> by Sinter.AspNetCore's [SinterEmbed]: the sinter build's sinter-embed.json, compiled in");
        b.AppendLine("#nullable enable");
        if (c.Namespace is not null) b.Append("namespace ").Append(c.Namespace).AppendLine(";");
        foreach (var x in c.Containers.Items) b.AppendLine(x).AppendLine("{");
        b.Append("partial ").Append(c.Keyword).Append(' ').AppendLine(c.Name).AppendLine("{");
        b.AppendLine("    private static global::Sinter.AspNetCore.SinterCompiledBuild? __sinterBuild;");
        b.AppendLine();
        b.AppendLine("    /// <summary>The sinter build compiled in by [SinterEmbed]: <c>builder.Services.AddSinter(" + c.Name + ".Build)</c>.</summary>");
        b.Append("    public static global::Sinter.AspNetCore.SinterCompiledBuild Build => __sinterBuild ??= global::Sinter.AspNetCore.SinterCompiledBuild.Create(__SinterManifest(), 0x")
            .Append(fingerprint.ToString("X16", CultureInfo.InvariantCulture)).Append("UL, ").Append(Lit(dir)).AppendLine(", __SinterConfigure);");
        b.AppendLine();
        b.AppendLine("    private static void __SinterConfigure(global::Sinter.AspNetCore.SinterOptions o)");
        b.AppendLine("    {");
        foreach (var s in c.Skips.Items) b.Append("        o.Skip(").Append(Lit(s.Name)).AppendLine(");");
        foreach (var r in c.Resolvers.Items) b.Append("        o.Resolve(").Append(Lit(r.Name)).Append(", ").Append(r.Call).AppendLine(");");
        b.AppendLine("    }");
        b.AppendLine();
        b.AppendLine("    private static " + M + "SinterManifest __SinterManifest() => new(");
        b.Append("        new " + M + "ManifestPage[] { ");
        foreach (var p in Objs(root["pages"]!))
        {
            b.Append("\n            new(").Append(Lit((string)p["file"]!)).Append(", ").Append(Strs((List<object?>)p["paths"]!)).Append(", new " + M + "ManifestSlot[] { ");
            foreach (var s in Objs(p["data"])) b.Append("\n                ").Append(SlotExpr(s)).Append(',');
            b.Append(" }");
            if (p.TryGetValue("arrays", out var arr) && arr is List<object?> al && al.Count > 0) b.Append(", ").Append(Strs(al));
            b.Append("),");
        }
        b.AppendLine(" },");
        b.Append("        new " + M + "ManifestRoute[] { ");
        if (root.TryGetValue("routes", out var routes) && routes is List<object?> rs)
            foreach (var r in Objs(rs))
                b.Append("\n            new(").Append(Lit((string)r["from"]!)).Append(", ").Append(Lit((string)r["to"]!)).Append(", ")
                    .Append(Convert.ToInt32((double)r["status"]!, CultureInfo.InvariantCulture).ToString(CultureInfo.InvariantCulture)).Append(", ")
                    .Append(r.TryGetValue("file", out var f) && f is string fs ? Lit(fs) : "null").Append(", ")
                    .Append(r.TryGetValue("choose", out var ch) && ch is true ? "true" : "false").Append("),");
        b.AppendLine(" },");
        if (root.TryGetValue("locales", out var l) && l is Dictionary<string, object?> ld)
            b.Append("        new " + M + "ManifestLocales(").Append(Lit((string)ld["base"]!)).Append(", ").Append(Strs((List<object?>)ld["list"]!)).Append(", ")
                .Append(Lit(ld.TryGetValue("at", out var a) && a is string s2 ? s2 : "/")).AppendLine("));");
        else b.AppendLine("        null);");
        b.AppendLine("}");
        foreach (var _ in c.Containers.Items) b.AppendLine("}");
        return b.ToString();
    }

    private static string SlotExpr(Dictionary<string, object?> s)
    {
        var src = s.TryGetValue("src", out var v) && v is List<object?> parts
            ? "new global::Sinter.AspNetCore.Manifest.UrlPart[] { " + string.Join(", ", parts.Select(p => p is string lit
                ? $"{M}UrlPart.Lit({Lit(lit)})"
                : $"{M}UrlPart.Url({Lit((string)((Dictionary<string, object?>)p!)["url"]!)})")) + " }"
            : "null";
        var inBrowser = s.TryGetValue("when", out var w) && w is true;
        var when = w is Dictionary<string, object?> cond ? CondExpr(cond) : "null";
        var start = s.TryGetValue("start", out var st) && st is Dictionary<string, object?> sd
            ? $"new {M}ManifestStart({Lit((string)sd["url"]!)}, {Lit((string)sd["key"]!)}, {Convert.ToUInt64((double)sd["size"]!, CultureInfo.InvariantCulture)}UL, {(sd.TryGetValue("skip", out var sk) && sk is true ? "true" : "false")}, {Pairs(sd, "query")})"
            : "null";
        // `headers`: the static headers of the resource's API (`sinter({ apis })`), an object
        var headers = s.TryGetValue("headers", out var hv) && hv is Dictionary<string, object?> hd && hd.Count > 0
            ? "new global::System.Collections.Generic.KeyValuePair<string, string>[] { " + string.Join(", ", hd.Where(x => x.Value is string).Select(x => $"new({Lit(x.Key)}, {Lit((string)x.Value!)})")) + " }"
            : "null";
        return $"new({Convert.ToInt32((double)s["id"]!, CultureInfo.InvariantCulture)}, {Lit((string)s["resource"]!)}, {src}, {(inBrowser ? "true" : "false")}, {when}, {Pairs(s, "query")}, {start}, {headers})";
    }

    private static string CondExpr(Dictionary<string, object?> c)
    {
        if (c.TryGetValue("not", out var n)) return $"{M}Cond.Not({CondExpr((Dictionary<string, object?>)n!)})";
        if (c.TryGetValue("and", out var a)) return $"{M}Cond.And({string.Join(", ", ((List<object?>)a!).Select(x => CondExpr((Dictionary<string, object?>)x!)))})";
        if (c.TryGetValue("or", out var o)) return $"{M}Cond.Or({string.Join(", ", ((List<object?>)o!).Select(x => CondExpr((Dictionary<string, object?>)x!)))})";
        var eq = c.TryGetValue("eq", out var e) && e is string es ? Lit(es) : "null";
        var ne = c.TryGetValue("ne", out var x2) && x2 is string ns ? Lit(ns) : "null";
        return $"{M}Cond.Url({Lit((string)c["url"]!)}, {eq}, {ne})";
    }

    private static string Pairs(Dictionary<string, object?> d, string name) =>
        d.TryGetValue(name, out var q) && q is List<object?> list && list.Count > 0
            ? "new global::System.Collections.Generic.KeyValuePair<string, string>[] { " + string.Join(", ", list.Select(p =>
            {
                var kv = (List<object?>)p!;
                return $"new({Lit((string)kv[0]!)}, {Lit((string)kv[1]!)})";
            })) + " }"
            : "global::System.Array.Empty<global::System.Collections.Generic.KeyValuePair<string, string>>()";

    private static string Strs(List<object?> l) => "new string[] { " + string.Join(", ", l.Select(x => Lit((string)x!))) + " }";

    private static string Lit(string s) => SymbolDisplay.FormatLiteral(s, quote: true);

    private static IEnumerable<Dictionary<string, object?>> Objs(object? list) => ((List<object?>)list!).Select(x => (Dictionary<string, object?>)x!);
}
