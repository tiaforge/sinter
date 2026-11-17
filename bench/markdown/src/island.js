// `<island-markdown>`: RealWorld's article body before sinter-markdown (examples/realworld, src/markdown.js)
import { marked } from 'marked';
import DOMPurify from 'dompurify';

customElements.define('island-markdown', class extends HTMLElement {
  constructor() {
    super();
    // rows are cloned from inert templates, so `source` may have been set before the upgrade
    if (Object.hasOwn(this, 'source')) { const md = this.source; delete this.source; this.source = md; }
  }
  set source(md) { this.innerHTML = DOMPurify.sanitize(marked.parse(md ?? '', { async: false })); }
});
