// Islands: browser work that sinter expressions cannot do (the token's storage, a redirect from a branch); Markdown is src/markdown.js.
import { clearPersisted, instance } from '@tiaforge-ui/sinter';
import { token } from './session.js';

// Events emitted from the pages with `emit(name, detail)`.
// signing in or out changes whose data this is: drop the page-load cache (`cache` resources)
document.addEventListener('signed-in', (e) => {
  clearPersisted();
  token.set(e.detail.user.token);
  location.assign(e.detail.to ?? '/');
});
document.addEventListener('signed-out', () => {
  clearPersisted();
  token.clear();
  location.assign('/');
});

/** `<conduit-redirect to="/login">`: replaces the location once rendered (e.g. inside a `data-sn-if`). */
customElements.define('conduit-redirect', class extends HTMLElement {
  connectedCallback() { location.replace(this.getAttribute('to') ?? '/'); }
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
