// `$url` written (a handler's `$url.page = 2`, a model on `$url`): the query string follows. The
// kind of history entry is decided where the write happens: a user's event pushes, typing commits
// at each pause (the first commit of a run pushes, later ones replace), anything else replaces.
// Per flush pass the strongest kind wins, written once after the render. Loaded only by pages that
// write `$url`.
import type { App, Feature } from './runtime/app.js';
import { wait } from './runtime/wait.js';

const REPLACE = 1, TYPED = 2, PUSH = 3;

/** A value as the URL holds it: a string, or null for none (`false`, `null`, `''`). */
const one = (v: unknown): string | null => (v == null || v === false || v === '' ? null : v === true ? '1' : '' + v);

const feature: Feature = {
  name: 'location',
  install(app: App) {
    // the parameters the path pattern carries (`:slug`) stay in the path
    const fromPath = new Set((app.ir.path ?? []).flatMap((p) => p.split('/').filter((s) => s[0] == ':').map((s) => s.slice(1))));
    /** parameters written since the last write to the history */
    const changed = new Set<string>();
    const pause = wait(app);
    /** the strongest kind this flush pass asked for; whether a typing run pushed its entry; whether `change` ended it before its pass */
    let kind = 0, run = false, fin = false;

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
      try { k == PUSH ? app.env.pushState(to) : app.env.replaceState(to); } catch (e) { app.warn(26, to, e); }
      return true;
    };
    const commit = () => { if (write(run ? REPLACE : PUSH)) run = true; };

    const arrays = new Set(app.ir.urlArrays);
    app.page.$u = (name: string, v: unknown, k = 0) => {
      const $url = app.page.$url, x = $url[name];
      // an array parameter is always a list (one value written to it is wrapped)
      const val = Array.isArray(x) || arrays.has(name) ? [x].flat().map(one).filter((y) => y != null) : one(x);
      // `$url` in memory is what a reload reads: strings, none for an empty value
      if (val == null || (Array.isArray(val) && !val.length && !arrays.has(name))) delete $url[name];
      else $url[name] = val;
      app.ext.location!.write(name, Math.max(k, app.push ? PUSH : REPLACE));
      return v;
    };
    app.ext.location = {
      write(name, k) {
        changed.add(name);
        if (k > kind) kind = k;
      },
      set(name, value, k) {
        const $url = app.page.$url;
        value == null ? delete $url[name] : ($url[name] = value);
        this.write(name, k);
        app.mark('$url');
      },
      end() {
        if (kind == TYPED) return void (fin = true);
        if (pause.on()) { pause.stop(); commit(); }
        run = false;
      },
    };
    app.afterFlush.push(() => {
      const k = kind;
      kind = 0;
      // a push takes what typing waits to commit with it, and ends the run
      if (k == PUSH) { pause.stop(); write(PUSH); run = false; }
      else if (k == TYPED) fin ? (fin = false, commit(), run = false) : pause.start(commit);
      // a replace while typing waits folds into its commit
      else if (k == REPLACE && !pause.on()) write(REPLACE);
    });
    // Back, Forward: the core reads `$url` again; nothing is written (unsafe names are dropped on
    // read, so a write could differ from the address bar), and what typing waited to commit is dropped
    app.addCleanup(app.env.listen('popstate', () => {
      pause.stop();
      changed.clear();
      kind = 0;
      run = fin = false;
    }));
  },
};
export default feature;
