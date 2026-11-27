// Dev builds: warnings with readable messages, frozen resource items and the
// "state changed outside sinter" detector. The compiler adds this module to
// the page in dev mode only, so none of it ships to production.
import type { App, Dirty, Feature } from './runtime/app.js';
import type { Binding } from './ir.js';
import { config } from './runtime/config.js';
import { inState } from './paths.js';

/** Messages for the core's warning codes; `%` takes the next argument. */
const MESSAGES: Record<number, string> = {
  1: 'node % is on the page twice (a `data-sn` element or an anchor comment `<!--sn …-->`); not bound',
  2: 'node % is missing (a `data-sn` element or an anchor comment `<!--sn …-->`); not bound. A minifier or CDN that strips HTML comments removes the anchors of lists and branches: turn comment stripping off for sinter pages',
  3: 'node % is <%>, expected <%> (`#`: an anchor comment `<!--sn …-->`); not bound',
  4: 'embedded data for `%` must be a <script> in <head>; ignored',
  5: 'embedded data for `%` is not valid JSON; ignored',
  6: 'binding `%` on <%>% threw: %',
  7: 'refused URL in `%` on <%>: %',
  8: 'refused style value for `%`: %',
  9: 'model on <%>% could not be set: %',
  11: 'duplicate key in `data-sn-for`: %',
  12: 'resource `%`: `select` path `%` is not an array',
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
  28: 'event `%` could not be applied: %',
  29: 'event `%` payload is missing key field(s) % for `%`',
  30: "page(%, 'last') needs a known total",
  35: "the build formatted this page's dates and numbers in its `<html lang>` (`%`), but the app's locale is `%`: the build found no `configure({ locale })` in the config or early module or what they import. Put it there (a `locale` key in `src/sinter.config.js`), so the build leaves formatting to the browser",
  33: '`%` of resource `%`, which has no `key` and holds a list, changes the whole list, not one item (SN542): add `key` with the field that identifies an item',
  31: 'anchor `<!--%-->` has no end comment `<!--/sn-->` after it: one was added. A minifier or CDN that strips HTML comments breaks lists and branches: turn comment stripping off for sinter pages',
  32: 'the early script requested `%`, and a request middleware changed the request (a header, its credentials): the response is not used, and the page sent it again. Add what the middleware adds in `sinter({ apis })` (`headers`, `credentials`, `token`) instead, or answer it from the middleware with `early="off"` on the resource',
  25: 'font % is preloaded (sinter({ fonts: { preload } })), but the page did not render with it in its first % frames: the preload competes with what the first paint needs, and when the font is slow it can hold the first paint. Preload a face the first view uses, or remove it',
  36: 'a write changed `%`, which nothing it marked reaches (it marked %): what reads it shows the old value until something else renders it. A write sinter cannot see changed one of the page\'s objects (a custom element or a library that changes an object it was handed, a timer), or sinter\'s write analysis missed an alias: report it.%',
  37: 'helper `%` changed %, which a helper may not do: it changes none of its arguments, and the page does not show what it changed. In the handler, change the state with the method itself (`tasks.sort(cmp)`, `ys[0].n++`), or return a new value from the helper and assign it (`tasks = sorted(tasks)`).%',
  22: "the page's Content-Security-Policy blocked an inline script (%): sinter's Speculation Rules are one, so the next page's HTML is not prefetched. If the policy comes from a response header, add 'inline-speculation-rules' to its script-src (a CSP in a <meta> gets their hash from the build), or set sinter({ prefetch: { html: { delivery: 'header' } } }). See docs/navigation.md",
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

/**
 * Runtime warnings that depend on the server, the browser or timing rather than on the page (an
 * HTTP/1.1 stream, a large response, a CSP header, a font's timing, the browser refusing a history
 * write): strict mode reports them but does not fail on them.
 */
export const ENVIRONMENT_WARNINGS: ReadonlySet<number> = new Set([18, 19, 22, 25, 26]);

/** One runtime warning, as strict mode's listeners get it (the dev server's relay, `render()` in tests). */
export interface RuntimeWarning {
  /** the core's warning number, or `null` for a message without one */
  code: number | null;
  message: string;
  /** an error (a handler or binding threw, an unhandled error) rather than a warning */
  error: boolean;
  /** depends on the environment: reported, never failed on (`ENVIRONMENT_WARNINGS`) */
  environment: boolean;
}

/**
 * Where runtime warnings go besides the console: kept from the start (the relay may load after the
 * page has mounted), and passed to `on` once something listens.
 */
export interface WarningSink {
  list: RuntimeWarning[];
  on: ((w: RuntimeWarning) => void) | null;
}

export const SINK = Symbol.for('sinter.warnings');

export function warningSink(): WarningSink {
  const g = globalThis as { [SINK]?: WarningSink };
  return (g[SINK] ??= { list: [], on: null });
}

function report(w: RuntimeWarning) {
  const sink = warningSink();
  if (sink.list.length < 200) sink.list.push(w);
  sink.on?.(w);
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

/**
 * The state as the dev module last saw it, per scope: each value by its path, and inside a plain object or array (not a
 * frozen one: a resource's item never changes), what it held. A frozen value, a function, a DOM node, a `Date`, a
 * `Map` is compared by identity. Bounded: a snapshot stops at `LIMIT` values.
 */
interface Snap { v: unknown; kids?: Map<string, Snap> }
const LIMIT = 20000;
const plain = (v: unknown): v is Record<string, unknown> => {
  if (!v || typeof v != 'object' || Object.isFrozen(v)) return false;
  const p = Object.getPrototypeOf(v);
  return Array.isArray(v) || p === Object.prototype || p === null;
};
/** an own property's value, or its getter (read without calling it: reading is no part of a check) */
const own = (o: object, k: string): unknown => { const d = Object.getOwnPropertyDescriptor(o, k); return d && ('value' in d ? d.value : d.get); };
function snapshot(v: unknown, budget: { n: number }, up: Set<unknown> = new Set()): Snap {
  if (--budget.n < 0 || !plain(v) || up.has(v)) return { v };
  up.add(v);
  const kids = new Map<string, Snap>();
  for (const k of Object.keys(v)) kids.set(k, snapshot(own(v, k), budget, up));
  up.delete(v);
  return { v, kids };
}
/** the paths below `at` whose value changed since `s` (a value replaced, a key added or removed), not looked into further */
function changes(s: Snap, now: unknown, at: string[], out: string[][]) {
  if (!Object.is(s.v, now)) { out.push(at); return; }
  if (!s.kids || !plain(now)) return;
  for (const [k, c] of s.kids) if (!Object.prototype.hasOwnProperty.call(now, k)) out.push([...at, k]); else changes(c, own(now, k), [...at, k], out);
  for (const k of Object.keys(now)) if (!s.kids.has(k)) out.push([...at, k]);
}
/**
 * Whether written path `w` (its segments, the `{name}` ones filled as the writer's scope had them) reaches the changed
 * path `p`: `p` is `w` or below it, where `*`, `#`, `~` and an unfilled `{name}` stand for any segment and `**` for any
 * rest, as the runtime's reach does (paths.ts `staticReach`: a write reaches what reads below it).
 */
export function covers(w: string[], p: string[]): boolean {
  for (let i = 0; i < w.length; i++) {
    const s = w[i]!;
    if (s == '**') return true;
    if (i >= p.length) return false;
    if (s == '*' || s == '#' || s == '~' || (s[0] == '{' && s.endsWith('}')) || s == p[i]) continue;
    return false;
  }
  // a change below the written path, in place: not through a list's element, which the runtime's reach does not go
  // into from above (a row renders again when its item is another, not when the list was written as a whole)
  return !p.slice(w.length).some((x) => /^\d+$/.test(x));
}

/** a key as it reads after an expression: `[0]`, `.n`, `["a b"]` */
const step = (k: string) => (/^\d+$/.test(k) ? `[${k}]` : /^[A-Za-z_$][\w$]*$/.test(k) ? `.${k}` : `[${JSON.stringify(k)}]`);

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
        if (code == 24) {
          const text = `sinter: handler${where} threw: ${message}`;
          console.error(text, e);
          report({ code, message: text, error: true, environment: false });
          return true;
        }
      }
      // what write-through applied is a trace, not a warning: logged at debug level each time, never reported to strict mode
      if (code == 21) { console.debug(`sinter: ${MESSAGES[21]!.replace(/%/g, () => String(args.shift()))}`); return; }
      let i = 0;
      const text = typeof code == 'string' ? code : MESSAGES[code]!.replace(/%/g, () => String(args[i++]).replace(/\x1f/g, ','));
      const msg = `sinter: ${text}`;
      if (seen.has(msg)) return;
      seen.add(msg);
      (code == 16 ? console.error : console.warn)(msg, ...args.slice(i));
      const n = typeof code == 'number' ? code : null;
      report({ code: n, message: msg, error: n == 16, environment: n != null && ENVIRONMENT_WARNINGS.has(n) });
    };
    app.prep = deepFreeze;
    // a resource without `key` is one object: an `upsert` of one item or a `merge` of one that holds a list replaces
    // or spoils the list (SN542 at build time, where its type says it is a list). Resources exist after install
    queueMicrotask(() => {
      for (const def of app.ir.resources ?? []) {
        if (def.key || def.each) continue;
        const r = app.resource(def.name);
        let list = Array.isArray(r.value());
        app.addCleanup(r.subscribe((c) => {
          if (list && (c.op == 'merge' || (c.op == 'upsert' && !Array.isArray(c.item)))) app.warn(33, c.op, def.name);
          list = Array.isArray(r.value());
        }));
      }
    });
    app.dupes = (keys) => {
      if (new Set(keys).size == keys.length) return;
      const k = keys.find((k, i) => keys.indexOf(k) != i);
      app.warn(11, typeof k == 'string' ? k.slice(1) : 'the same object twice');
    };
    // retries: each failed try, each resend and the outcome
    app.req.log = (m) => console.info(`sinter: retry ${m}`);
    app.req.resent = (url) => app.warn(32, url);
    for (const a of app.ir.actions) if (a.retry && !config.retry?.has(a.retry)) app.warn(23, a.retry);
    // text formatted at build in `<html lang>` while the app's own locale source says another (it was out of the build's sight)
    const lf = app.ir.lf, now = lf && config.locale?.get();
    if (lf && now && now != lf) app.warn(35, lf, now);
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

    // a helper called in a handler changes none of its arguments (docs/spec.md, Method classes): the dev page module
    // calls it through `$.$hc(f, name, texts)(...args)`, which looks at its object arguments before and after the call
    // (bounded as the write check is) and names what changed (warning 37). What it reported, warnings 15 and 36 do not
    // report again at the next flush
    let quiet = false;
    const ran: string[] = [];
    app.page.$hc = (f: (...a: unknown[]) => unknown, name: string, texts: string[]) => (...args: unknown[]) => {
      const budget = { n: LIMIT };
      const before = args.map((a) => (plain(a) ? snapshot(a, budget) : null));
      const r = f(...args);
      const changed: string[] = [];
      before.forEach((s, i) => {
        if (!s) return;
        const out: string[][] = [];
        changes(s, args[i], [], out);
        for (const p of out) changed.push('`' + (texts[i] ?? `argument ${i + 1}`) + p.map(step).join('') + '`');
      });
      if (changed.length) {
        quiet = true;
        app.warn(37, name, changed.slice(0, 4).join(', ') + (changed.length > 4 ? `, and ${changed.length - 4} more` : ''), ran.length ? ` What ran: ${ran.join(', ')}` : '');
      }
      return r;
    };

    // each concrete path a write changed is reached by a path it marked (warning 36). The state is looked at whenever
    // a flush starts, and what changed since the last look is checked against what was marked since: every writer
    // (handlers, models, actions' `then` and `catch`, resources' and streams' `then`, component scripts) marks first
    const ps = app.ir.ps, names = ps?.n;
    if (ps && names) {
      const segs = (d: Dirty): string[] => {
        const out: string[] = [];
        for (let n = d.w; n >= 0; n = ps.p[n]!) out.unshift(names[n]!);
        let slot = 0;
        return out.map((s) => (s[0] == '{' && s.endsWith('}') ? d.v[slot++] ?? s : s));
      };
      const exec = app.exec;
      app.exec = (f, s, writes, o) => {
        const b = o as (Binding & { at?: Record<number, string> }) | undefined;
        const at = b?.at?.[f] ?? (b?.k == 'on' && b.x != null ? app.ir.actions[b.x]?.at?.[f] : undefined) ?? onlyAt(app, f);
        if (at && ran.length < 8 && !ran.includes(at)) ran.push(at);
        return exec(f, s, writes, o);
      };
      let snaps: Map<number, Snap> | null = null;
      const look = () => { const budget = { n: LIMIT }; snaps = new Map(app.states.map(([sid, obj]) => [sid, snapshot(obj, budget)])); };
      app.beforeFlush.push((dirty) => {
        if (snaps) for (const [sid, obj] of app.states) {
          const s = snaps.get(sid);
          if (!s) continue;
          const out: string[][] = [];
          changes(s, obj, [`$s${sid}`], out);
          if (!out.length) continue;
          const marked = dirty.filter((d) => d.w >= 0).map(segs);
          // a scope none of the marks is in: warning 15 says it
          if (!dirty.some((p) => inState(ps, p, sid))) continue;
          if (!quiet) for (const p of out) if (!marked.some((w) => covers(w, p))) {
            const mine = marked.filter((w) => w[0] == `$s${sid}`).map((w) => w.join('.'));
            app.warn(36, p.join('.').replace(/^\$s\d+\./, ''), mine.length ? mine.slice(0, 6).map((x) => `\`${x.replace(/^\$s\d+\./, '')}\``).join(', ') + (mine.length > 6 ? `, and ${mine.length - 6} more` : '') : 'nothing of it', ran.length ? ` What ran: ${ran.join(', ')}` : ' No handler ran.');
          }
        }
        ran.length = 0;
        look();
      });
      app.afterFlush.push(() => { if (!snaps) look(); });
    }
    const json = (o: unknown) => { try { return JSON.stringify(o); } catch { return ''; } };
    let last: string[] = [];
    app.beforeFlush.push((dirty) => app.states.forEach(([sid, obj], i) => {
      if (!quiet && json(obj) != last[i] && !dirty.some((p) => inState(app.ir.ps!, p, sid))) app.warn(15, Object.keys(obj).join('`, `'));
    }));
    app.afterFlush.push(() => { last = app.states.map(([, obj]) => json(obj)); quiet = false; });
  },
};

export default dev;
