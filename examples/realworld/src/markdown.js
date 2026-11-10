// `<conduit-markdown>` with a `source` property: renders sanitized Markdown. Only the article page
// loads this module (its own `<script>`), so no other page carries the dynamic imports and Vite's
// preload helper that comes with them (~600 B gzip). The renderer is requested as soon as the
// module runs, alongside the article's data, not once the data has arrived; it stays out of the
// page module's static graph, so the page mounts without waiting for it.
const renderer = Promise.all([import('marked'), import('dompurify')]).then(([{ marked }, { default: DOMPurify }]) =>
  (md) => DOMPurify.sanitize(marked.parse(md ?? '', { async: false })));

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
  // `rendered` once the body is in: public/styles.css keeps what follows the body out of the layout
  // until then, so the body arriving does not push the tags and comments down. If the renderer
  // fails to load, the source shows as text, and the rest of the page with it.
  set source(md) {
    this.#md = md;
    const show = (fill) => { if (this.#md === md) { fill(); this.toggleAttribute('rendered', true); } };
    renderer.then((html) => show(() => { this.innerHTML = html(md); }), () => show(() => { this.textContent = md ?? ''; }));
  }
});
