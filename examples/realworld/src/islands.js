// Islands: browser work that sinter expressions cannot do.
import { instance } from '@tiaforge-ui/sinter';

/** A stylesheet that does not hold the first paint (`media="print"` in the head) applies from here, on the page's mount. */
for (const l of document.querySelectorAll('link[data-late]')) l.media = 'all';

/** The debug interface the RealWorld e2e suite reads; the token is where the API's `token.storage` keeps it (apis.js). */
const token = () => localStorage.getItem('jwtToken');
const user = () => { try { return instance(document).resource('user'); } catch { return null; } };
window.__conduit_debug__ = {
  getToken: token,
  getAuthState() {
    const r = user();
    if (!r || r.meta.error) return r ? 'unavailable' : 'loading';
    if (r.meta.loadedAt == null) return 'loading';
    return r.value() ? 'authenticated' : 'unauthenticated';
  },
  getCurrentUser() {
    const u = user()?.value();
    return u ? { ...u, token: token() } : null;
  },
};
