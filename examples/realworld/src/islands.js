// Islands: browser work that sinter expressions cannot do (the token's storage, a redirect from a branch).
import { clearPersisted, instance, navigate } from '@tiaforge-ui/sinter';
import { token } from './session.js';

// the page module has mounted (the first page and each one swapped in): src/styles.css stops holding back what follows
// the article's body, which renders at mount (<md-doc data-sn-early="off">)
document.addEventListener('sn-page', () => document.documentElement.toggleAttribute('data-mounted', true));

// Events emitted from the pages with `emit(name, detail)`.
// signing in or out changes whose data this is: drop the page-load cache (`cache` resources)
document.addEventListener('signed-in', (e) => {
  clearPersisted();
  token.set(e.detail.user.token);
  navigate(e.detail.to ?? '/');
});
// the same account with new settings: the token may be new, the cached data is still this account's
document.addEventListener('settings-saved', (e) => { token.set(e.detail.token); });
document.addEventListener('signed-out', () => {
  clearPersisted();
  token.clear();
  navigate('/');
});

/** `<conduit-redirect to="/login">`: replaces the current entry once rendered, e.g. inside a `data-sn-if` (a swap, with swaps on). */
customElements.define('conduit-redirect', class extends HTMLElement {
  connectedCallback() { navigate(this.getAttribute('to') ?? '/', { replace: true }); }
});

/** The debug interface the RealWorld e2e suite reads. */
const user = () => { try { return instance(document).resource('user'); } catch { return null; } };
window.__conduit_debug__ = {
  getToken: () => token.get(),
  getAuthState() {
    const r = user();
    if (!r || r.meta.error) return r ? 'unavailable' : 'loading';
    if (r.meta.loadedAt == null) return 'loading';
    return r.value() ? 'authenticated' : 'unauthenticated';
  },
  getCurrentUser() {
    const u = user()?.value();
    return u ? { ...u, token: token.get() } : null;
  },
};
