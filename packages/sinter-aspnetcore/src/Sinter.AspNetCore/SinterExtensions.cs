using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;
using Sinter.AspNetCore;

namespace Microsoft.Extensions.DependencyInjection
{
    /// <summary>Registers sinter's middleware.</summary>
    public static class SinterServiceCollectionExtensions
    {
        /// <summary>
        /// A build read at startup from <see cref="SinterOptions.Dir"/>: its <c>sinter-embed.json</c> is
        /// parsed and checked against the configuration when the app starts (in <c>UseSinter</c>).
        /// </summary>
        public static IServiceCollection AddSinter(this IServiceCollection services, Action<SinterOptions> configure)
        {
            services.Configure(configure);
            services.AddSingleton<SinterEngine>(Create);
            return services;
        }

        /// <summary>
        /// A build compiled in by [SinterEmbed]: checked when the project compiles, no manifest parsed at
        /// startup (the build directory's must still be the same one), resolvers bound without reflection.
        /// </summary>
        public static IServiceCollection AddSinter(this IServiceCollection services, SinterCompiledBuild build, Action<SinterOptions>? configure = null)
        {
            services.Configure<SinterOptions>(o =>
            {
                o.Compiled = build;
                build.Configure(o);
            });
            if (configure is not null) services.Configure(configure);
            services.AddSingleton<SinterEngine>(Create);
            return services;
        }

        private static SinterEngine Create(IServiceProvider sp) =>
            new(sp.GetRequiredService<IOptions<SinterOptions>>().Value,
                sp.GetService<IWebHostEnvironment>()?.ContentRootPath ?? AppContext.BaseDirectory,
                sp.GetRequiredService<ILoggerFactory>().CreateLogger("Sinter.AspNetCore"));
    }
}

namespace Microsoft.AspNetCore.Builder
{
    /// <summary>Adds sinter's middleware to the pipeline.</summary>
    public static class SinterApplicationBuilderExtensions
    {
        /// <summary>
        /// Answers the build's pages with their data written in, and follows its URL rules. Put it before
        /// the static files (<c>UseStaticFiles</c>), which serve everything else of the build. The build
        /// and the configuration are checked here: a placeholder without a source throws, every problem
        /// in the message.
        /// </summary>
        public static IApplicationBuilder UseSinter(this IApplicationBuilder app)
        {
            var engine = app.ApplicationServices.GetService<SinterEngine>()
                ?? throw new InvalidOperationException("Sinter.AspNetCore: call builder.Services.AddSinter(…) before app.UseSinter()");
            engine.Api ??= new InProcessApi(app, engine.Options.ApiMiddleware);
            return app.Use(next => new SinterMiddleware(next, engine).InvokeAsync);
        }
    }
}
