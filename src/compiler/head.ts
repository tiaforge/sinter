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

/** elements that only a head holds; `<script>`, `<style>` and `<noscript>` may be in either */
const HEAD_ONLY = new Set(['title', 'meta', 'link', 'base']);
const EITHER = new Set(['script', 'style', 'noscript']);

/**
 * What a component's `<template data-sn-props>` declares, from its markup: `head` when it holds head elements
 * (`<title>`, `<meta>`, `<link>`, `<base>`, or head components, through `data-sn-if`/`data-sn-for` templates and
 * slots) and nothing for a body; `body` when it holds anything a head cannot (text, another element, a body
 * component); `either` when it holds only what both can (slots, `<script>`, `<style>`, `<noscript>`): its kind is
 * where it is used. `headTag` says whether a component's tag is a head component (null: neither, or unknown).
 */
export function componentKind(template: P5Element, headTag?: (tag: string) => boolean | null): 'head' | 'body' | 'either' {
  let head = false, body = false;
  const walk = (p: P5Parent) => {
    for (const c of p.childNodes) {
      if (c.nodeName === '#text') { if ((c as DefaultTreeAdapterMap['textNode']).value.trim()) body = true; continue; }
      if (!('tagName' in c)) continue;
      const el = c as P5Element;
      if (el.tagName === 'template') walk((el as DefaultTreeAdapterMap['template']).content);
      else if (el.tagName === 'slot') walk(el);
      else if (HEAD_ONLY.has(el.tagName)) head = true;
      else if (EITHER.has(el.tagName)) continue;
      else if (el.tagName.includes('-') && !el.tagName.startsWith('sn-')) { const k = headTag?.(el.tagName); if (k === true) head = true; else if (k === false) body = true; }
      else body = true;
    }
  };
  walk((template as DefaultTreeAdapterMap['template']).content);
  return body ? 'body' : head ? 'head' : 'either';
}

/** a component template's declaration: `data-sn-props`, or a name it had before (reported by the compiler) */
export const declares = (t: P5Element) => t.attrs.some((a) => a.name === 'data-sn-props' || a.name === 'data-sn-head' || a.name === 'data-sn-component');
/** what makes a `<template>` a branch, a list or a text, never a component's declaration */
export const STRUCTURAL = ['data-sn-if', 'data-sn-else', 'data-sn-for', 'data-sn-text'];

/**
 * A component file's declaration, among its top-level nodes: the `<template>` with `data-sn-props` (or a retired
 * name), else its only top-level `<template>` when that is no branch, list or text (`STRUCTURAL`): a component
 * without props needs no `data-sn-props=""`. Null: none (the compiler says why: two templates, a structural one).
 */
export function declaringTemplate(nodes: readonly P5Node[]): P5Element | null {
  const ts = nodes.filter((c): c is P5Element => 'tagName' in c && c.tagName === 'template');
  return ts.find(declares) ?? (ts.length === 1 && !ts[0]!.attrs.some((a) => STRUCTURAL.includes(a.name)) ? ts[0]! : null);
}

/** a component file's text: its kind (`componentKind`); a template with the old `data-sn-head` is a head component */
export function kindOfComponent(text: string, headTag?: (tag: string) => boolean | null): 'head' | 'body' | 'either' | null {
  const frag = parse5.parseFragment(text);
  const t = declaringTemplate(frag.childNodes);
  if (!t) return null;
  if (t.attrs.some((a) => a.name === 'data-sn-head')) return 'head';
  if (t.attrs.some((a) => a.name === 'data-sn-component')) return 'body';
  return componentKind(t, headTag);
}

/** whether a component file is a head component wherever it is used (an `either` one is not) */
export function isHeadComponent(text: string, headTag?: (tag: string) => boolean | null): boolean {
  return kindOfComponent(text, headTag) === 'head';
}

/**
 * Component kinds read from files, as the compiler decides them (`componentKind`, a tag in a component counting by
 * its own kind): for the editor and the generated types, which read files without compiling. `read` returns a
 * component's text by tag, or null. Cached per tag; a cycle counts as unknown.
 */
export function componentKinds(read: (tag: string) => string | null): (tag: string) => 'head' | 'body' | 'either' | null {
  const known = new Map<string, 'head' | 'body' | 'either' | null>(), deciding = new Set<string>();
  const kind = (tag: string): 'head' | 'body' | 'either' | null => {
    if (known.has(tag)) return known.get(tag)!;
    if (deciding.has(tag)) return null;
    const text = read(tag);
    if (text == null) { known.set(tag, null); return null; }
    deciding.add(tag);
    const k = kindOfComponent(text, (t) => { const x = kind(t); return x === 'head' ? true : x === 'body' ? false : null; });
    deciding.delete(tag);
    known.set(tag, k);
    return k;
  };
  return kind;
}
