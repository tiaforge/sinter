// The comparison point: RealWorld's article body (examples/realworld/src/markdown.js), the same code and
// versions. A custom element renders sanitized HTML from marked through innerHTML, which needs a
// Trusted Types policy: this page's CSP has script-src and style-src but no require-trusted-types-for.
import { marked } from 'marked';
import DOMPurify from 'dompurify';

const renderer = Promise.resolve((md) => DOMPurify.sanitize(marked.parse(md ?? '', { async: false })));

customElements.define('island-markdown', class extends HTMLElement {
  #md = '';
  constructor() {
    super();
    if (Object.hasOwn(this, 'source')) { const md = this.source; delete this.source; this.source = md; }
  }
  set source(md) {
    this.#md = md;
    const show = (fill) => { if (this.#md === md) { fill(); this.toggleAttribute('rendered', true); } };
    renderer.then((html) => show(() => { this.innerHTML = html(md); }), () => show(() => { this.textContent = md ?? ''; }));
  }
});
