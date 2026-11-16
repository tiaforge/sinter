// The build's HTML minifier (`CompileOptions.minify`). It runs on the page's tree after components are
// expanded and before the walk, so everything the compiler counts afterwards (node paths in templates,
// one-element rows, anchors, text separators) is counted on the minified markup: nothing is minified after
// sinter has written its own comments. It changes only what shows the same:
//
// - the author's comments are removed (the forms sinter reserves stay, so `SN105` still reports them);
// - in text whose white space collapses (layout.ts `collapsesSpace`: never `<pre>`, `<textarea>`, `pre-*`,
//   editable content, or anything the stylesheets cannot decide), each run of white space becomes one
//   character: a newline if it had one (a segment break, which a browser may drop between East Asian
//   letters), else a space;
// - white space that starts or ends a line is removed: beside a block-level box in normal flow, and in a
//   flex or grid container or the table boxes that hold rows and cells, where white space alone renders
//   nothing (`blockLevel`, `childLayout`, at every viewport width);
// - an element whose white space was its only content keeps one character (`:empty` would match without it).
//
// Without a layout (the build has not read the page's stylesheets, or the page loads one from another
// origin) only comments are removed.
import type { DefaultTreeAdapterMap } from 'parse5';
import type { Layout } from './layout.js';

type P5Node = DefaultTreeAdapterMap['node'];
type P5Element = DefaultTreeAdapterMap['element'];
type P5Parent = DefaultTreeAdapterMap['parentNode'];
type P5Template = DefaultTreeAdapterMap['template'];
type P5Text = DefaultTreeAdapterMap['textNode'];

const HTML_NS = 'http://www.w3.org/1999/xhtml';
/** sinter's anchor comments, exactly (as in compile.ts): kept, so the walk reports the author's ones (`SN105`) */
const RESERVED = /^(?:sn(?: \d+)?|\/sn)?$/;
/** elements whose children are text the parser does not split, or content sinter does not own */
const RAW = new Set(['script', 'style', 'textarea', 'title', 'noscript', 'xmp', 'iframe', 'noembed', 'noframes', 'plaintext', 'pre', 'listing']);
/** attributes whose binding writes the element's content: what is written there now is not the page's */
const OWNS_CONTENT = new Set(['data-sn-text', 'data-sn-html']);
const SPACE = /[\t\n\f\r ]+/g;
const ALL_SPACE = /^[\t\n\f\r ]*$/;

export interface MinifyHooks {
  /** the page's cascade; null: only comments are removed */
  layout: Layout | null;
  /** an element whose box the layout cannot judge (markup a component's scoped styles reach): left as written */
  opaque(el: P5Element): boolean;
  /** an element the compiler takes out of the page (`<sn-resource>`, `<sn-sync>`): no box, and the text around it meets */
  removed(el: P5Element): boolean;
}

const isEl = (n: P5Node): n is P5Element => 'tagName' in n;
const isText = (n: P5Node): n is P5Text => n.nodeName === '#text';
/** sinter's templates: what they render takes their place in the page; their content is the page's markup */
const isSinterTemplate = (el: P5Element) => el.tagName === 'template' && el.attrs.some((a) => a.name === 'data-sn-for' || a.name === 'data-sn-if' || a.name === 'data-sn-else');
/** a run of white space as one character: a newline if it had one, else a space */
const one = (run: string) => (/[\n\r]/.test(run) ? '\n' : ' ');

export function minifyMarkup(doc: P5Parent, hooks: MinifyHooks): { comments: number; bytes: number } {
  const stats = { comments: 0, bytes: 0 };
  const layout = hooks.layout;
  const owns = (el: P5Element) => el.attrs.some((a) => OWNS_CONTENT.has(a.name) || (a.name === 'data-sn-prop' && /\b(innerHTML|textContent|innerText|outerHTML)\b/.test(a.value)));

  /** the author's comments out of `p`, and text nodes that meet merged */
  const comments = (p: P5Parent) => {
    const out: P5Node[] = [];
    for (const c of p.childNodes as P5Node[]) {
      if (c.nodeName === '#comment' && !RESERVED.test((c as DefaultTreeAdapterMap['commentNode']).data)) {
        stats.comments++;
        stats.bytes += (c as DefaultTreeAdapterMap['commentNode']).data.length + 7;
        continue;
      }
      const last = out[out.length - 1];
      if (isText(c) && last && isText(last)) { last.value += c.value; continue; }
      out.push(c);
    }
    p.childNodes = out as never;
  };

  /**
   * `p`'s children, recursively. `box`: the element whose box holds them (for a template's content, the box the
   * template is in); `full`: its text collapses white space and the layout can say so.
   */
  const visit = (p: P5Parent, box: P5Element | null, full: boolean) => {
    comments(p);
    for (const c of p.childNodes as P5Node[]) {
      if (!isEl(c)) continue;
      if (c.tagName === 'template') {
        // the author's templates are the author's (a script may read them as written)
        if (isSinterTemplate(c)) visit((c as P5Template).content, box, full);
        else if (c.attrs.some((a) => a.name.startsWith('data-sn'))) visit((c as P5Template).content, null, false);
        continue;
      }
      if (RAW.has(c.tagName)) { if (c.tagName === 'pre' || c.tagName === 'listing') visit(c, null, false); continue; }
      const foreign = c.namespaceURI !== HTML_NS;
      const keep = foreign || !layout || owns(c) || hooks.opaque(c) || !layout.collapsesSpace(c);
      visit(c, foreign ? null : c, !keep);
    }
    // nothing in the document, `<html>` or `<head>` renders white space between elements
    if (p === doc || (isEl(p as P5Node) && ((p as P5Element).tagName === 'html' || (p as P5Element).tagName === 'head'))) {
      p.childNodes = (p.childNodes as P5Node[]).filter((c) => !(isText(c) && ALL_SPACE.test(c.value) && (stats.bytes += c.value.length, true))) as never;
    } else if (full && box && layout) spaces(p, box, layout);
  };

  /** sinter templates that render only block-level boxes, or nothing: white space beside them is beside a block or meets what is past them */
  const blockOrNothing = new Map<P5Element, boolean>();
  const rendersBlocks = (t: P5Element, l: Layout): boolean => {
    let r = blockOrNothing.get(t);
    if (r !== undefined) return r;
    blockOrNothing.set(t, false);
    const kids = ((t as P5Template).content?.childNodes ?? []) as P5Node[];
    r = kids.some(isEl) && kids.every((c) => c.nodeName === '#comment' || (isText(c) && ALL_SPACE.test(c.value))
      || (isEl(c) && c.namespaceURI === HTML_NS && !hooks.opaque(c) && (isSinterTemplate(c) ? rendersBlocks(c, l) : !hooks.removed(c) && l.blockLevel(c))));
    blockOrNothing.set(t, r);
    return r;
  };

  /** the white space of `p`'s text children, in `box` */
  const spaces = (p: P5Parent, box: P5Element, l: Layout) => {
    const kids = p.childNodes as P5Node[];
    const kind = l.childLayout(box);
    // the edges of a template's content are not the box's: what is around the template is not known here
    const edges = kind === 'block' && isEl(p as P5Node) && l.edgesStartLines(box);
    /**
     * What is past the text at `i` in direction `d`, through white space, comments, the elements the compiler
     * removes and templates that render blocks or nothing: a block-level box, the box's edge, or other content.
     */
    const side = (i: number, d: -1 | 1): 'block' | 'edge' | 'other' => {
      for (let j = i + d; j >= 0 && j < kids.length; j += d) {
        const n = kids[j]!;
        if (n.nodeName === '#comment' || (isText(n) && ALL_SPACE.test(n.value))) continue;
        if (!isEl(n) || n.namespaceURI !== HTML_NS || hooks.opaque(n)) return 'other';
        if (hooks.removed(n)) continue;
        if (n.tagName === 'template') { if (isSinterTemplate(n) && rendersBlocks(n, l)) continue; return 'other'; }
        return l.blockLevel(n) ? 'block' : 'other';
      }
      return edges ? 'edge' : 'other';
    };
    /**
     * In a flex, grid or table container: whether the text at `i` meets the end of its item in direction `d` (an
     * element that is an item, the container's edge), through comments, the elements the compiler removes, white
     * space and templates that render such elements or nothing.
     */
    const item = (i: number, d: -1 | 1): 'block' | 'other' => {
      for (let j = i + d; j >= 0 && j < kids.length; j += d) {
        const n = kids[j]!;
        if (n.nodeName === '#comment' || (isText(n) && ALL_SPACE.test(n.value))) continue;
        if (!isEl(n) || n.namespaceURI !== HTML_NS || hooks.opaque(n)) return 'other';
        if (hooks.removed(n)) continue;
        if (n.tagName === 'template') { if (isSinterTemplate(n) && rendersBlocks(n, l)) continue; return 'other'; }
        return l.isItem(n) ? 'block' : 'other';
      }
      return isEl(p as P5Node) ? 'block' : 'other';
    };
    // a neighbour through the elements the compiler removes, or null at the edge of `p`
    const near = (i: number, d: -1 | 1): P5Node | null => {
      for (let j = i + d; j >= 0 && j < kids.length; j += d) { const n = kids[j]!; if (!(isEl(n) && hooks.removed(n))) return n; }
      return null;
    };
    const had = kids.some((c) => c.nodeName !== '#comment');
    const out: P5Node[] = [];
    let firstDropped: P5Text | null = null;
    for (let i = 0; i < kids.length; i++) {
      const c = kids[i]!;
      if (!isText(c)) { out.push(c); continue; }
      const was = c.value;
      let v = was.replace(SPACE, one);
      // a text right after another one (an element the compiler removes was between): their white space is one run
      const last = out.length ? out[out.length - 1]! : null;
      if (last && isText(last) && near(i, -1) && isText(near(i, -1)!) && ALL_SPACE.test(v)) {
        if (v === '\n' && /[\t\f ]$/.test(last.value)) last.value = last.value.replace(/[\t\f ]+$/, '\n');
        stats.bytes += was.length;
        continue;
      }
      if (kind !== null) {
        // in a flex or grid container and the table boxes, a run of text is an item of its own, which ends at an
        // element that is an item and at the container's edges (a `::before` is an item there too)
        const left = kind === 'items' ? item(i, -1) : side(i, -1), right = kind === 'items' ? item(i, 1) : side(i, 1);
        if (ALL_SPACE.test(v)) { if (left !== 'other' || right !== 'other') v = ''; }
        else {
          if (left !== 'other') v = v.replace(/^[\t\n\f\r ]+/, '');
          if (right !== 'other') v = v.replace(/[\t\n\f\r ]+$/, '');
        }
      }
      stats.bytes += was.length - v.length;
      if (!v) { if (!firstDropped) { firstDropped = c; c.value = one(was); } continue; }
      c.value = v;
      out.push(c);
    }
    // `:empty` matches an element with nothing but comments in it (sinter's anchors are comments): one that had white space keeps it
    if (firstDropped && had && isEl(p as P5Node) && !out.some((c) => !(c.nodeName === '#comment' || (isEl(c) && (isSinterTemplate(c) || hooks.removed(c)))))) {
      out.unshift(firstDropped);
      stats.bytes -= firstDropped.value.length;
    }
    p.childNodes = out as never;
  };

  visit(doc, null, false);
  return stats;
}
