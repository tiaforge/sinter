// `<conduit-markdown>` with a `source` property: renders sanitized Markdown. Only the article page
// loads this module (its own `<script>`), and it stays out of the page module's graph, so the page
// mounts without waiting for it. Its imports are static: the build lists them in the page's head
// (`<link rel="modulepreload">`), so marked and DOMPurify download with the page, in parallel,
// instead of after this module has run (dynamic imports start only then). The article body is the
// page's largest element: with its data in the page (sinter-axum), a lazy renderer was what held it.
import { marked } from 'marked';
import DOMPurify from 'dompurify';

const renderer = Promise.resolve((md) => DOMPurify.sanitize(marked.parse(md ?? '', { async: false })));

customElements.define('conduit-markdown', class extends HTMLElement {
  #md = '';
  constructor() {
    super();
    // rows are cloned from inert templates, so `source` may have been set before the upgrade
    if (Object.hasOwn(this, 'source')) {
      const md = this.source;
      delete this.source;
      this.source = md;
    }
  }
  // `rendered` once the body is in: src/styles.css keeps what follows the body out of the layout
  // until then, so the body arriving does not push the tags and comments down. If the renderer
  // fails to load, the source shows as text, and the rest of the page with it.
  set source(md) {
    this.#md = md;
    const show = (fill) => { if (this.#md === md) { fill(); this.toggleAttribute('rendered', true); } };
    renderer.then((html) => show(() => { this.innerHTML = html(md); }), () => show(() => { this.textContent = md ?? ''; }));
  }
});
