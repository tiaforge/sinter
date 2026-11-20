// Islands: browser work that sinter expressions cannot do (a redirect from a branch).
import { instance, navigate } from '@tiaforge-ui/sinter';

/** `<conduit-redirect to="/login">`: replaces the current entry once rendered, e.g. inside a `data-sn-if` (a swap, with swaps on). */
customElements.define('conduit-redirect', class extends HTMLElement {
  connectedCallback() { navigate(this.getAttribute('to') ?? '/', { replace: true }); }
});

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
