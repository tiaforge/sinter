// Dev builds: warnings with readable messages, frozen resource items and the
// "state changed outside sinter" detector. The compiler adds this module to
// the page in dev mode only, so none of it ships to production.
import type { App, Feature } from './runtime/app.js';
import type { Binding } from './ir.js';
import { config } from './runtime/config.js';
import { inState } from './paths.js';

/** Messages for the core's warning codes; `%` takes the next argument. */
const MESSAGES: Record<number, string> = {
  1: 'duplicate `data-sn="%"`; not bound',
  2: 'missing `data-sn="%"`; not bound',
  3: '`data-sn="%"` is on <%>, expected <%>; not bound',
  4: 'embedded data for `%` must be a <script> in <head>; ignored',
  5: 'embedded data for `%` is not valid JSON; ignored',
  6: 'binding `%` on <%>% threw: %',
  7: 'refused URL in `%` on <%>: %',
  8: 'refused style value for `%`: %',
  9: 'model on <%>% could not be set: %',
  10: 'a `data-sn-for` over primitive values needs `data-sn-key`',
  11: 'duplicate key in `data-sn-for`: %',
  12: 'resource `%`: `items` path `%` is not an array',
  13: 'resource `%`: duplicate key `%`; the last one wins',
  14: 'resource `%`: item is missing key field `%`',
  15: 'state `%` changed outside sinter: write it from a handler, or a component script\'s `this.state`',
  16: 'unhandled error%: %',
  17: 'resource `%`: src could not be resolved: %',
  18: 'stream `%` is served over HTTP/1.1, where browsers allow 6 connections per origin: with more than 5 tabs of this app open, pages stop loading. Serve it over HTTP/2 (any TLS reverse proxy such as nginx or Caddy), or use the WebSocket transport',
  19: 'resource `%`: % KB of data is over the page-load cache limit of 256 KB per entry; not cached',
  20: "`run('%')`: no element with that id and an action is on the page (a `data-sn-if` branch that is not rendered?); nothing ran",
  21: 'write-through after `%`: %',
  23: '`data-sn-retry="%"`: no such retry policy in `configure({ retry })`; the action fails when triggered',
  26: 'the browser refused to write the URL `%` (history calls made too often?): %; `$url` keeps the value',
  27: 'an object was written to `$url.%`: the URL holds strings, so the parameter is removed',
  25: 'font % is preloaded (sinter({ fonts: { preload } })), but the page did not render with it in its first % frames: the preload competes with what the first paint needs, and when the font is slow it can hold the first paint. Preload a face the first view uses, or remove it',
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

/** The frames after mount within which a preloaded font must have been used (warning 25). */
export const FONT_FRAMES = 3;

function deepFreeze<T>(v: T): T {
  if (v && typeof v == 'object' && !Object.isFrozen(v)) {
    Object.freeze(v);
    for (const k of Object.keys(v)) deepFreeze((v as Record<string, unknown>)[k]);
  }
  return v;
}

/** Where function `f` was written, when one place in the IR uses it (a resource's or a stream event's `then`). */
function onlyAt(app: App, f: number): string | undefined {
  const owners = [...app.ir.resources, ...(app.ir.syncs ?? []).flatMap((s) => s.events)].filter((o) => o.at?.[f]);
  return owners.length == 1 ? owners[0]!.at![f] : undefined;
}

const dev: Feature = {
  name: 'dev',
  install(app: App) {
    const seen = new Set<string>();
    app.dev = true;
    app.warn = (code, ...args) => {
      // a throwing expression: the core passes what threw; the message names its place in the markup and
      // the error follows (its stack, through the page module's source map, points at the expression too)
      if (code == 6 || code == 9 || code == 24) {
        const [o, el, e] = code == 24 ? [args[0], null, args[2]] : args as [Binding, Element, unknown];
        const f = code == 24 ? (args[1] as number) : code == 6 ? (o as Binding).f! : (o as Binding).a!;
        // an action's `then` and `catch` run for its trigger binding (`x`: the action)
        const b = o as (Binding & { at?: Record<number, string> }) | undefined;
        const at = b?.at?.[f] ?? (b?.k == 'on' && b.x != null ? app.ir.actions[b.x]?.at?.[f] : undefined) ?? onlyAt(app, f);
        const where = at ? ` at ${at}` : '';
        const message = (e as Error)?.message ?? String(e);
        args = code == 24 ? [where, message, e] : [...(code == 6 ? [(o as Binding).k] : []), el!.localName, where, message, e];
        // each failed run of a handler is reported, as the core reports it without the dev module
        if (code == 24) return console.error(`sinter: handler${where} threw: ${message}`, e), true;
      }
      let i = 0;
      const text = typeof code == 'string' ? code : MESSAGES[code]!.replace(/%/g, () => String(args[i++]).replace(/\x1f/g, ','));
      const msg = `sinter: ${text}`;
      if (seen.has(msg)) return;
      seen.add(msg);
      (code == 16 ? console.error : console.warn)(msg, ...args.slice(i));
    };
    app.prep = deepFreeze;
    app.dupes = (keys) => {
      if (new Set(keys).size == keys.length) return;
      const k = keys.find((k, i) => keys.indexOf(k) != i);
      app.warn(11, typeof k == 'string' ? k.slice(1) : 'the same object twice');
    };
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
    // preloaded fonts: a face is loaded only once something is laid out with it, so a face of a preload that is
    // still `unloaded` after the first frames was not used by them (the preload's file does not load the face)
    const fontLinks = doc ? [...doc.querySelectorAll<HTMLLinkElement>('link[rel="preload"][as="font"][data-sn-font]')] : [];
    const raf = globalThis.requestAnimationFrame;
    if (fontLinks.length && doc?.fonts && raf) {
      let n = 0, stopped = false;
      const check = () => {
        if (stopped) return;
        if (++n < FONT_FRAMES) { raf(check); return; }
        const faces = [...doc.fonts as unknown as Iterable<FontFace>];
        for (const l of fontLinks) {
          const [family, weight, style] = l.dataset.snFont!.split(';');
          const mine = faces.filter((f) => f.family.replace(/^(['"])(.*)\1$/, '$2').toLowerCase() == family!.toLowerCase() && String(f.weight) == weight && f.style == style);
          if (mine.length && mine.every((f) => f.status == 'unloaded')) app.warn(25, `${family} ${weight}${style == 'italic' ? ' italic' : ''}`, FONT_FRAMES);
        }
      };
      raf(check);
      app.addCleanup(() => { stopped = true; });
    }
    app.streamOpened = (url) => {
      if (/^http\/1\./i.test(protocolOf(url, app.env.href()) ?? '')) app.warn(18, url);
    };

    const json = (o: unknown) => { try { return JSON.stringify(o); } catch { return ''; } };
    let last: string[] = [];
    app.beforeFlush.push((dirty) => app.states.forEach(([sid, obj], i) => {
      if (json(obj) != last[i] && !dirty.some((p) => inState(app.ir.ps!, p, sid))) app.warn(15, Object.keys(obj).join('`, `'));
    }));
    app.afterFlush.push(() => { last = app.states.map(([, obj]) => json(obj)); });
  },
};

export default dev;
