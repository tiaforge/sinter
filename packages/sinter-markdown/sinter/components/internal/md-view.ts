// The script of <md-view>, <md-doc>'s renderer for a document that arrives at run time: its tree as elements, created
// directly (../../build.ts), several times faster than through the components. A new document replaces the one
// before, whole.
import { build } from '../../build.js';
import type { Root } from '../../sinter.types.js';
import { MdViewComponent } from './md-view.html';

export class MdView extends MdViewComponent {
  #of: Root | null | undefined = undefined;
  connected() { this.#render(); }
  propsChanged() { this.#render(); }
  #render() {
    const d = this.props.doc ?? null;
    if (d === this.#of) return;
    this.#of = d;
    if (d) this.root.replaceChildren(build(d)); else this.root.replaceChildren();
  }
}
