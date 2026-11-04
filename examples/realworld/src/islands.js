// Islands: browser work that sinter expressions cannot do (storage, navigation, HTML rendering).
import DOMPurify from 'dompurify';
import { marked } from 'marked';
import { instance } from '@tiaforge/sinter';
import { token } from './session.js';

// Events emitted from the pages with `emit(name, detail)`.
document.addEventListener('signed-in', (e) => {
  token.set(e.detail.user.token);
  location.assign(e.detail.to ?? '/');
});
document.addEventListener('signed-out', () => {
  token.clear();
  location.assign('/');
});
document.addEventListener('navigate', (e) => location.assign(e.detail));

/** `<conduit-redirect to="/login">`: replaces the location once rendered (e.g. inside a `data-sn-if`). */
customElements.define('conduit-redirect', class extends HTMLElement {
  connectedCallback() { location.replace(this.getAttribute('to') ?? '/'); }
});

/** `<conduit-markdown>` with a `source` property: renders sanitized Markdown. */
customElements.define('conduit-markdown', class extends HTMLElement {
  constructor() {
    super();
    // rows are cloned from inert templates, so `source` may have been set before the upgrade
    if (Object.hasOwn(this, 'source')) {
      const md = this.source;
      delete this.source;
      this.source = md;
    }
  }
  set source(md) { this.innerHTML = DOMPurify.sanitize(marked.parse(md ?? '', { async: false })); }
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
