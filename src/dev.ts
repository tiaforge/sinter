// Dev builds: warnings with readable messages, frozen resource items and the
// "state changed outside sinter" detector. The compiler adds this module to
// the page in dev mode only, so none of it ships to production.
import type { App, Feature } from './runtime/app.js';
import { config } from './runtime/config.js';

/** Messages for the core's warning codes; `%` takes the next argument. */
const MESSAGES: Record<number, string> = {
  1: 'duplicate `data-sn="%"`; not bound',
  2: 'missing `data-sn="%"`; not bound',
  3: '`data-sn="%"` is on <%>, expected <%>; not bound',
  4: 'embedded data for `%` must be a <script> in <head>; ignored',
  5: 'embedded data for `%` is not valid JSON; ignored',
  6: 'binding `%` on <%> threw: %',
  7: 'refused URL in `%` on <%>: %',
  8: 'refused style value for `%`: %',
  9: 'model on <%> could not be set: %',
  10: 'a `data-sn-for` over primitive values needs `data-sn-key`',
  11: 'duplicate key in `data-sn-for`: %',
  12: 'resource `%`: `items` path `%` is not an array',
  13: 'resource `%`: duplicate key `%`; the last one wins',
  14: 'resource `%`: item is missing key field `%`',
  15: 'state `%` changed outside sinter: use `update()`',
  16: 'unhandled error%: %',
  17: 'resource `%`: src could not be resolved: %',
  18: 'stream `%` is served over HTTP/1.1, where browsers allow 6 connections per origin: with more than 5 tabs of this app open, pages stop loading. Serve it over HTTP/2 (any TLS reverse proxy such as nginx or Caddy), or use the WebSocket transport',
  19: 'resource `%`: % KB of data is over the page-load cache limit of 256 KB per entry; not cached',
  20: "`run('%')`: no element with that id and an action is on the page (a `data-sn-if` branch that is not rendered?); nothing ran",
  21: 'write-through after `%`: %',
  23: '`data-sn-retry="%"`: no such retry policy in `configure({ retry })`; the action fails when triggered',
  22: "the page's Content-Security-Policy blocked an inline script (%): sinter's Speculation Rules are one, so the next page's HTML is not prefetched. If the policy comes from a response header, add 'inline-speculation-rules' to its script-src (a CSP in a <meta> gets their hash from the build), or set sinter({ speculation: { mode: 'prefetch', delivery: 'header' } }). See docs/navigation.md",
};

/**
 * The HTTP version the origin of `url` was reached over, from Resource Timing: the page's
 * navigation for a same-origin URL, else the latest request to that origin. An open stream has
 * no entry of its own until it ends. Null when unknown (no request yet, or a cross-origin
 * server without `Timing-Allow-Origin`).
 */
export function protocolOf(url: string, base: string, perf: Pick<Performance, 'getEntriesByType'> | undefined = globalThis.performance): string | null {
  let origin: string;
  try { origin = new URL(url, base).origin; } catch { return null; }
  const entries = [...(perf?.getEntriesByType?.('navigation') ?? []), ...(perf?.getEntriesByType?.('resource') ?? []).slice().reverse()] as PerformanceResourceTiming[];
  for (const e of entries) {
    let o: string;
    try { o = new URL(e.name).origin; } catch { continue; }
    if (o === origin && e.nextHopProtocol) return e.nextHopProtocol;
  }
  return null;
}

function deepFreeze<T>(v: T): T {
  if (v && typeof v == 'object' && !Object.isFrozen(v)) {
    Object.freeze(v);
    for (const k of Object.keys(v)) deepFreeze((v as Record<string, unknown>)[k]);
  }
  return v;
}

const dev: Feature = {
  name: 'dev',
  install(app: App) {
    const seen = new Set<string>();
    app.dev = true;
    app.warn = (code, ...args) => {
      let i = 0;
      const text = typeof code == 'string' ? code : MESSAGES[code]!.replace(/%/g, () => String(args[i++]).replace(/\x1f/g, ','));
      const msg = `sinter: ${text}`;
      if (seen.has(msg)) return;
      seen.add(msg);
      (code == 16 ? console.error : console.warn)(msg, ...args.slice(i));
    };
    app.prep = deepFreeze;
    // retries: each failed try, each resend and the outcome
    app.req.log = (m) => console.info(`sinter: retry ${m}`);
    for (const a of app.ir.actions) if (a.retry && !config.retry?.has(a.retry)) app.warn(23, a.retry);
    // the Speculation Rules are inline: a CSP from a response header (the build cannot see it) blocks
    // them while the page is parsed, before this runs; a buffered observer still gets that report
    const doc = app.root && (app.root.ownerDocument ?? (app.root as Document)), RO = (globalThis as any).ReportingObserver;
    if (RO && doc?.querySelector('script[type="speculationrules"]')) {
      const ro = new RO((reports: Array<{ body: { blockedURL?: string; effectiveDirective?: string } }>) => {
        const r = reports.find((x) => x.body.blockedURL == 'inline' && /^script-src/.test(x.body.effectiveDirective ?? ''));
        if (r) { app.warn(22, r.body.effectiveDirective); ro.disconnect(); }
      }, { types: ['csp-violation'], buffered: true });
      ro.observe();
      app.addCleanup(() => ro.disconnect());
    }
    app.streamOpened = (url) => {
      if (/^http\/1\./i.test(protocolOf(url, app.env.href()) ?? '')) app.warn(18, url);
    };

    const json = (o: unknown) => { try { return JSON.stringify(o); } catch { return ''; } };
    let last: string[] = [];
    app.beforeFlush.push((dirty) => app.states.forEach(([sid, obj], i) => {
      if (json(obj) != last[i] && !dirty.some((p) => p[0] == '$s' + sid)) app.warn(15, Object.keys(obj).join('`, `'));
    }));
    app.afterFlush.push(() => { last = app.states.map(([, obj]) => json(obj)); });
  },
};

export default dev;
