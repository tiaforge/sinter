// The script of <md-view>, <md-doc>'s renderer for a document that arrives at run time: its tree as elements, created
// directly (../../build.ts), several times faster than through the components. A new document replaces the one
// before, whole. Where the document is in the page (embedded data), the early script has built it already
// (md-view.early.ts, the same elements from the same data): the first connect keeps those.
import { build } from '../../build.js';
import type { Root } from '../../sinter.types.js';
import { MdViewComponent } from './md-view.html';

export class MdView extends MdViewComponent {
  #of: Root | null | undefined = undefined;
  connected() {
    if (this.early) this.#of = this.props.doc ?? null;
    else this.#render();
  }
  propsChanged() { this.#render(); }
  #render() {
    const d = this.props.doc ?? null;
    if (d === this.#of) return;
    this.#of = d;
    if (d) this.root.replaceChildren(build(d)); else this.root.replaceChildren();
  }
}
