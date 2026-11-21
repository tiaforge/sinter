// `data-sn-signed-in` (docs/apis.md#pages-that-need-a-session): the page needs a session of its API's token. With
// none stored (and its condition over `$url` true), the visitor goes to the API's `signIn`, with the return URL, in
// the current history entry. The early script does it before anything paints and the page module then never mounts;
// this module does it at mount without one (`firstPaint: false`, a swap to the page), after a 401 that took the token,
// and when a `$url` change makes the condition true. A prerendered page waits until it is shown. An explicit
// `signOut()` leaves it to the handler (it navigates on). Convenience, not security: the server refuses the requests.
import type { App, Feature } from './runtime/app.js';
import { tokens } from './runtime/request.js';
import { read, signInOf } from './token.js';

const feature: Feature = {
  name: 'signed-in',
  install(app: App) {
    const g = app.ir.si!, env = app.env;
    let gone = false;
    tokens.out = false;
    const check = () => {
      if (gone || tokens.out || read(g.t as Parameters<typeof read>[0], env) != null) return;
      try { if (g.f != null && !app.fns[g.f]!(app.page)) return; } catch { return; }
      gone = true;
      (env.replace ?? ((u: string) => location.replace(u)))(signInOf(g.i, env));
    };
    app.shown(check);
    // after each change: a 401 that took the token, `$url` that makes the condition true
    app.afterFlush.push(() => app.shown(check));
  },
};
export default feature;
