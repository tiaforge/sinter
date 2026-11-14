// `$url` written (a handler's `$url.page = 2`, a model on `$url`): the query string follows. The
// kind of history entry is decided where the write happens: a user's event pushes (a keystroke,
// `input`, replaces), the compiler fixes it for models and choices, anything else replaces. Per
// flush pass the strongest kind wins, written once after the render. Typing and a number field's
// steps wait for a pause: typing.ts, only on pages with such a model. Also here, so pages without
// them carry none of it: array parameters read as lists, and what a flush that follows Back or
// Forward must not write. Loaded only by pages that write `$url`.
import type { App, Feature } from './runtime/app.js';
import { lists } from './runtime/lists.js';

/** history entries, weakest first: replace, typing (a text field), a burst (a number field's steps), push */
const REPLACE = 1, TYPED = 2, PUSH = 4;

const feature: Feature = {
  name: 'location',
  install(app: App) {
    // `$url` is one object for the life of the page: the core reads it again in place
    const arrays = app.ir.urlArrays ?? [], $url = app.page.$url;
    // the parameters the path patterns carry (`:slug`) stay in the path
    const segs = (app.ir.path ?? []).flatMap((p) => p.split('/'));
    /** parameters written since the last write to the history */
    const changed = new Set<string>();
    /** the strongest kind this flush pass asked for; whether this flush follows Back or Forward */
    let kind = 0, back = false;

    /** A value as the URL holds it: a string, or null for none (`false`, `null`, `''`; an object, with a dev warning). */
    const one = (v: unknown, name: string): string | null => {
      // an object or a function (`Object(v)` is `v` itself only for those)
      if (Object(v) === v) return void app.warn(27, name), null;
      return v == null || v === false || v === '' ? null : v === true ? '1' : '' + v;
    };

    /** a new history entry (the environment's, read at each call) */
    const push = (x: string) => (app.env.pushState ? app.env.pushState(x) : history.pushState(null, '', x));
    /** The query with the changed parameters set or deleted, in their places; false when it equals the current one. */
    const write = (k: number): boolean => {
      const u = new URL(app.env.href()), q = new URLSearchParams();
      // a parameter's values (none, one, a list), unless they are there: where its first key was, else at the end
      const put = (n: string) => { if (!q.has(n)) for (const x of [$url[n] ?? []].flat()) q.append(n, x); };
      for (const [n, v] of u.searchParams) changed.has(n) ? put(n) : q.append(n, v);
      changed.forEach(put);
      changed.clear();
      if ('' + q == '' + u.searchParams) return false;
      u.search = '' + q;
      const to = u.pathname + u.search + u.hash;
      // browsers refuse history calls made too often (Safari throws): `$url` keeps the value
      try { k == PUSH ? push(to) : app.env.replaceState(to); } catch (e) { app.warn(26, to, e); }
      return true;
    };
    /**
     * The user's event (the testing module's simulated ones too), not a keystroke. A select's change counts
     * untrusted too: Playwright's selectOption() and testing libraries dispatch it, and the history a test sees
     * must be the one a user gets.
     */
    const user = (e: Event | null) => e && e.type != 'input' && ((app.env.trusted ? app.env.trusted(e) : e.isTrusted) || e.type == 'change' && (e.target as Element).localName == 'select');
    /** A parameter was written: `k` from the compiler (a model's control, a choice) or the pager, else from the event that caused the write. */
    const note = (name: string, k: number) => {
      if (!segs.includes(':' + name)) changed.add(name);
      kind = Math.max(kind, k || (user(app.ev) ? PUSH : REPLACE));
    };

    // `$url` as the page module reads it, array parameters as lists (the core reads one value per name)
    lists(app.env.href(), arrays, $url);
    // `$url` in memory is what a reload reads: strings, none for an empty value. A list written to
    // one value keeps its last item, as a reload of its repeated keys would read it.
    app.page.$u = (name: string, v: unknown, k = 0) => {
      const val = one([$url[name]].flat().pop(), name);
      val == null ? delete $url[name] : ($url[name] = val);
      note(name, k);
      return v;
    };
    // an array parameter (the compiler sends its writes here): always a list, one value written to it wrapped
    app.page.$l = (name: string, v: unknown, k = 0) => {
      $url[name] = [$url[name]].flat().map((y) => one(y, name)).filter((y) => y != null);
      note(name, k);
      return v;
    };
    app.ext.location = {
      get back() { return back; },
      get kind() { return kind; },
      commit: write,
      push,
      arrive() {
        changed.clear();
        kind = 0;
        back = true;
      },
      set(name, value, k) {
        value == null ? delete $url[name] : ($url[name] = value);
        note(name, k);
        app.mark('$url.' + name);
      },
    };
    // after Back or Forward, the core has read `$url` again: array parameters as lists, before the render
    app.beforeFlush.push(() => { if (back) lists(app.env.href(), arrays, $url); });
    app.afterFlush.push(() => {
      const k = kind, t = app.ext.typing;
      kind = 0;
      // a push takes what typing waits to commit with it, and ends the run
      if (k == PUSH) { t?.stop(); write(PUSH); }
      // typing, a number field's steps: at their pause (typing.ts)
      else if (k >= TYPED) t!.flush(k);
      // a replace while typing waits folds into its commit
      else if (k == REPLACE && !t?.waits()) write(REPLACE);
      // the flush that follows Back or Forward ends with its last pass
      if (!app.isDirty) back = false;
    });
    // Back, Forward: the core reads `$url` again; nothing is written (unsafe names are dropped on
    // read, so a write could differ from the address bar), and what waited to commit is dropped
    app.addCleanup(app.env.listen('popstate', () => {
      app.ext.typing?.stop();
      changed.clear();
      kind = 0;
      back = true;
    }));
  },
};
export default feature;
