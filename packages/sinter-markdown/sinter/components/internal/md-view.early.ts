// The early renderer of <md-view> (docs/components.md#early-renderers in sinter): where the document is in the page
// (embedded data, `embed: true`), the early script builds it into the root before the first paint, with the elements
// md-view.ts would build at mount, and the instance keeps them (`this.early`). Bundled only into the early files of the
// pages that render a use of it early; it imports neither the component's base class nor the runtime.
import { build } from '../../build.js';
import type { Root } from '../../sinter.types.js';

export default function (root: Element, props: { doc?: Root | null }): boolean {
  let all = true;
  const d = props.doc ?? null;
  if (d) root.replaceChildren(build(d, () => { all = false; }));
  // a URL attribute the early copy of the check refused (a scheme the app's configure() allows): the page module builds it
  if (!all) root.replaceChildren();
  return all;
}
