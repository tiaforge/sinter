// The head of a page or a layout, parsed so that every element stays where it is written
// (docs/proposals/layouts.md, Parsing the head). The standard parser ends the head at the first
// element it does not know there (a component's tag, a `<slot>`), and moves it and everything after
// it into the body. sinter parses a head's content as template content instead, where any element
// stays: the output still holds only head elements in the head (SN320 reports the rest, after expansion).
import * as parse5 from 'parse5';
import type { DefaultTreeAdapterMap } from 'parse5';

type P5Node = DefaultTreeAdapterMap['node'];
type P5Element = DefaultTreeAdapterMap['element'];
type P5Parent = DefaultTreeAdapterMap['parentNode'];
type P5Document = DefaultTreeAdapterMap['document'];

const OPTS = { sourceCodeLocationInfo: true } as const;

/** What a head may hold after expansion: what the browser keeps in it. */
export const HEAD_ELEMENTS = new Set(['title', 'meta', 'link', 'script', 'style', 'noscript', 'base', 'template']);

/**
 * Parses a document, with the content of a written `<head>…</head>` parsed as template content at
 * the same offsets. A document without both tags is what `parse5.parse` gives.
 */
export function parseDocument(html: string): P5Document {
  const doc = parse5.parse(html, OPTS);
  const range = headRange(doc, html);
  if (!range) return doc;
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

/** elements that only a head holds (a body component's root is none of these) */
const HEAD_ONLY = new Set(['title', 'meta', 'link', 'base', 'script', 'style', 'noscript']);

/**
 * Whether a component's `<template data-sn-props>` declares a head component: its markup is head
 * elements (through `data-sn-if`/`data-sn-for` templates and slots) and head components, at least one of
 * them. A body component's root is one element that is none of them; a template of slots alone is a body
 * component. `headTag` says whether a component's tag is a head component; without it (the editor, the
 * types), a component's tag is neither.
 */
export function holdsHead(template: P5Element, headTag?: (tag: string) => boolean): boolean {
  let head = false;
  const walk = (p: P5Parent): boolean => {
    for (const c of p.childNodes) {
      if (c.nodeName === '#text' && (c as DefaultTreeAdapterMap['textNode']).value.trim()) return false;
      if (!('tagName' in c)) continue;
      const el = c as P5Element;
      if (el.tagName === 'template') { if (!walk((el as DefaultTreeAdapterMap['template']).content)) return false; }
      else if (el.tagName === 'slot') { if (!walk(el)) return false; }
      else if (HEAD_ONLY.has(el.tagName)) head = true;
      else if (el.tagName.includes('-') && !el.tagName.startsWith('sn-')) { if (!headTag) continue; if (headTag(el.tagName)) head = true; else return false; }
      else return false;
    }
    return true;
  };
  return walk((template as DefaultTreeAdapterMap['template']).content) && head;
}

/** a component file's text: whether it is a head component (`<template data-sn-props>` over head elements) */
export function isHeadComponent(text: string, headTag?: (tag: string) => boolean): boolean {
  const frag = parse5.parseFragment(text);
  const t = frag.childNodes.find((c): c is P5Element => 'tagName' in c && (c as P5Element).tagName === 'template'
    && (c as P5Element).attrs.some((a) => a.name === 'data-sn-props' || a.name === 'data-sn-head'));
  return !!t && (t.attrs.some((a) => a.name === 'data-sn-head') || holdsHead(t, headTag));
}
