// `$url` written (a handler's `$url.page = 2`, a model on `$url`): the query string follows. The
// kind of history entry is decided where the write happens: a user's event pushes, typing commits
// at each pause (the first commit of a run pushes, later ones replace), a number field's burst of
// steps pushes once at its pause, anything else replaces. Per flush pass the strongest kind wins,
// written once after the render. Also here, so pages without them carry none of it: array
// parameters read as lists, and what a flush that follows Back or Forward must not write. Loaded
// only by pages that write `$url`.
import { MODEL, type App, type Feature, type Tagged } from './runtime/app.js';
import { lists } from './runtime/url.js';
import { wait } from './runtime/wait.js';

/** history entries, weakest first: replace, typing (a text field), a burst (a number field's steps), push */
const REPLACE = 1, TYPED = 2, BURST = 3, PUSH = 4;

const feature: Feature = {
  name: 'location',
  install(app: App) {
    const ps = app.ir.ps!, arrays = app.ir.urlArrays ?? [];
    // the parameters the path pattern carries (`:slug`) stay in the path
    const fromPath = new Set((app.ir.path ?? []).flatMap((p) => p.split('/').filter((s) => s[0] == ':').map((s) => s.slice(1))));
    /** parameters written since the last write to the history */
    const changed = new Set<string>();
    const pause = wait(app);
    /**
     * the strongest kind this flush pass asked for; whether a typing run pushed its entry; whether
     * `change` ended it before its pass; whether this flush follows Back or Forward
     */
    let kind = 0, run = false, fin = false, back = false;

    /** A value as the URL holds it: a string, or null for none (`false`, `null`, `''`; an object, with a dev warning). */
    const one = (v: unknown, name: string): string | null => {
      if (v != null && (typeof v == 'object' || typeof v == 'function')) return void app.warn(27, name), null;
      return v == null || v === false || v === '' ? null : v === true ? '1' : '' + v;
    };

    /** The query with the changed parameters set or deleted, in their places; false when it equals the current one. */
    const write = (k: number): boolean => {
      const u = new URL(app.env.href()), q = new URLSearchParams(), done = new Set<string>(), $url = app.page.$url;
      const put = (n: string) => {
        done.add(n);
        const v = $url[n];
        for (const x of Array.isArray(v) ? v : v == null ? [] : [v]) q.append(n, x);
      };
      for (const [n, v] of u.searchParams) changed.has(n) && !fromPath.has(n) ? done.has(n) || put(n) : q.append(n, v);
      for (const n of changed) if (!done.has(n) && !fromPath.has(n)) put(n);
      changed.clear();
      if ('' + q == '' + u.searchParams) return false;
      u.search = '' + q;
      const to = u.pathname + u.search + u.hash;
      // browsers refuse history calls made too often (Safari throws): `$url` keeps the value
      try { k == PUSH ? (app.env.pushState ?? ((x) => history.pushState(null, '', x)))(to) : app.env.replaceState(to); } catch (e) { app.warn(26, to, e); }
      return true;
    };
    const commit = () => { if (write(run ? REPLACE : PUSH)) run = true; };
    /** The user's event (the testing module's simulated ones too), and not a keystroke (`input` in a text field). */
    const user = (e: Event | null) => !!e && (app.env.trusted ? app.env.trusted(e) : e.isTrusted) && (e.type != 'input' || /^(checkbox|radio|select)/.test((e.target as HTMLInputElement).type));

    // `$url` as the page module reads it, array parameters as lists (the core reads one value per name)
    lists(app.env.href(), arrays, app.page.$url);
    app.page.$u = (name: string, v: unknown, k = 0) => {
      const $url = app.page.$url, x = $url[name];
      // an array parameter is always a list (one value written to it is wrapped)
      const list = Array.isArray(x) || arrays.includes(name);
      const val = list ? [x].flat().map((y) => one(y, name)).filter((y) => y != null) : one(x, name);
      // `$url` in memory is what a reload reads: strings, none for an empty value
      if (val == null || (list && !val.length && !arrays.includes(name))) delete $url[name];
      else $url[name] = val;
      // a number field's burst is its own kind; otherwise a user's event pushes
      app.ext.location!.write(name, k == BURST ? k : Math.max(k, user(app.ev) ? PUSH : REPLACE));
      return v;
    };
    app.ext.location = {
      get back() { return back; },
      write(name, k) {
        changed.add(name);
        if (k > kind) kind = k;
      },
      set(name, value, k) {
        const $url = app.page.$url;
        value == null ? delete $url[name] : ($url[name] = value);
        this.write(name, k);
        app.mark('$url.' + name);
      },
      end() {
        if (kind == TYPED) return void (fin = true);
        if (pause.on()) { pause.stop(); commit(); }
        run = false;
      },
    };
    // `change` on a text field bound to the URL (Enter, or leaving it): what typing waits to commit is
    // committed, the run ends. A model on state does not end it.
    const change = (e: Event) => {
      const m = (e.target as Tagged | null)?.[MODEL];
      if (m?.b.n == 'text' && (m.b.w ?? []).some((p) => { let n = p as number; while (ps.p[n]! >= 0) n = ps.p[n]!; return n == ps.x.$url; })) app.ext.location!.end();
    };
    // in the capture phase, before the page's own `change` handlers (as the core's models)
    const ET = EventTarget.prototype;
    ET.addEventListener.call(app.root, 'change', change, true);
    app.addCleanup(() => ET.removeEventListener.call(app.root, 'change', change, true));
    // after Back or Forward, the core has read `$url` again: array parameters as lists, before the render
    app.beforeFlush.push(() => { if (back) lists(app.env.href(), arrays, app.page.$url); });
    app.afterFlush.push(() => {
      const k = kind;
      kind = 0;
      // a push takes what typing waits to commit with it, and ends the run
      if (k == PUSH) { pause.stop(); write(PUSH); run = false; }
      // a number field's steps: one entry once they pause (it takes what typing waited to commit too)
      else if (k == BURST) { run = false; pause.start(() => write(PUSH)); }
      else if (k == TYPED) fin ? (fin = false, commit(), run = false) : pause.start(commit);
      // a replace while typing waits folds into its commit
      else if (k == REPLACE && !pause.on()) write(REPLACE);
      // the flush that follows Back or Forward ends with its last pass
      if (!app.isDirty) back = false;
    });
    // Back, Forward: the core reads `$url` again; nothing is written (unsafe names are dropped on
    // read, so a write could differ from the address bar), and what waited to commit is dropped
    app.addCleanup(app.env.listen('popstate', () => {
      pause.stop();
      changed.clear();
      kind = 0;
      run = fin = false;
      back = true;
    }));
  },
};
export default feature;
