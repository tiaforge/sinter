// The head of a page or a layout, parsed so that every element stays where it is written
// (docs/proposals/layouts.md, Parsing the head). The standard parser ends the head at the first
// element it does not know there (a component's tag, a `<slot>`), and moves it and everything after
// it into the body. Such a head is parsed again as template content, where any element stays: the
// output still holds only head elements in the head (SN320 reports the rest, after expansion).
import * as parse5 from 'parse5';
import type { DefaultTreeAdapterMap } from 'parse5';

type P5Node = DefaultTreeAdapterMap['node'];
type P5Element = DefaultTreeAdapterMap['element'];
type P5Parent = DefaultTreeAdapterMap['parentNode'];
type P5Document = DefaultTreeAdapterMap['document'];

const OPTS = { sourceCodeLocationInfo: true } as const;

/** What a head may hold after expansion: what the browser keeps in it, and sinter's own elements, which the build removes. */
export const HEAD_ELEMENTS = new Set(['title', 'meta', 'link', 'script', 'style', 'noscript', 'base', 'template', 'sn-resource', 'sn-sync']);

/**
 * Parses a document. A head the standard parser would cut short (an element from between `<head>`
 * and `</head>` ends up outside the head) is parsed again as template content, at the same offsets;
 * any other document is exactly what `parse5.parse` gives.
 */
export function parseDocument(html: string): P5Document {
  const doc = parse5.parse(html, OPTS);
  const range = headRange(doc, html);
  if (!range || !misplaced(doc, range)) return doc;
  const [from, to] = range;
  // the document without the head's content (blanked, so every offset stays), and the content on its own
  const blank = (s: string) => s.replace(/[^\r\n]/g, ' ');
  const out = parse5.parse(html.slice(0, from) + blank(html.slice(from, to)) + html.slice(to), OPTS);
  const head = findHead(out)!;
  const context = parse5.defaultTreeAdapter.createElement('template', parse5.html.NS.HTML, []);
  const frag = parse5.parseFragment(context, blank(html.slice(0, from)) + html.slice(from, to), OPTS);
  const nodes = frag.childNodes as P5Node[];
  // the blanked prefix joined the content's leading whitespace: keep only that whitespace
  const first = nodes[0];
  if (first?.nodeName === '#text') {
    const t = first as DefaultTreeAdapterMap['textNode'];
    const end = t.sourceCodeLocation?.endOffset ?? from;
    if (end <= from) nodes.shift();
    else {
      t.value = html.slice(from, end);
      if (t.sourceCodeLocation) t.sourceCodeLocation.startOffset = from;
    }
  }
  head.childNodes = nodes as never[];
  for (const n of nodes) (n as { parentNode: P5Parent }).parentNode = head;
  return out;
}

/** The offsets of the head's content in the source: from the end of `<head>` to `</head>`; null without both tags. */
function headRange(doc: P5Document, html: string): [number, number] | null {
  const head = findHead(doc);
  const start = head?.sourceCodeLocation?.startTag;
  if (!start) return null;
  const re = /<\/head\s*>/gi;
  re.lastIndex = start.endOffset;
  const m = re.exec(html);
  return m ? [start.endOffset, m.index] : null;
}

/** Whether an element written between `<head>` and `</head>` is outside the head in the parsed document. */
function misplaced(doc: P5Document, [from, to]: [number, number]): boolean {
  const head = findHead(doc)!;
  const walk = (n: P5Parent): boolean => {
    for (const c of n.childNodes) {
      if (!('tagName' in c)) continue;
      const el = c as P5Element;
      if (el === head) continue;
      const at = el.sourceCodeLocation?.startOffset;
      if (at !== undefined && at >= from && at < to) return true;
      if (walk(el)) return true;
    }
    return false;
  };
  return walk(doc);
}

export function findHead(doc: P5Parent): P5Element | null {
  for (const c of doc.childNodes) {
    if (!('tagName' in c)) continue;
    const el = c as P5Element;
    if (el.tagName === 'head') return el;
    const h = findHead(el);
    if (h) return h;
  }
  return null;
}
