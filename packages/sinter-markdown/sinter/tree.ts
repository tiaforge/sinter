// Helpers that read a parsed tree: `md.headings` (a table of contents) and `md.text` (a description, a
// reading time). This module does not import the parser, so these stay ordinary helpers when an app
// makes the parser lazy (`sinter({ lazy })`): they render early and fold at build time on their own.
// Pure functions of their arguments, with no globals beyond the language's.
import type { Block, Inline, MdNode, Root, TocEntry } from './sinter.types.js';

/** The headings of `doc`, at any depth, in order: `{ depth, id, text }`, the ids the anchors have. */
export function headings(doc: Root | null | undefined): TocEntry[] {
  const out: TocEntry[] = [];
  const walk = (nodes: readonly Block[]) => {
    for (const n of nodes) {
      if (n.type === 'heading') out.push({ depth: n.depth, id: 'md-' + n.slug, text: text(n) });
      else if (n.type === 'blockquote' || n.type === 'details') walk(n.children);
      else if (n.type === 'list') for (const i of n.children) walk(i.children);
    }
  };
  if (doc) walk(doc.children);
  return out;
}

/**
 * The plain text of a node, a list of nodes or a document: inline content run together (an image
 * gives its alt text, a break a space), blocks separated by a blank line. `''` for nothing.
 */
export function text(node: MdNode | readonly MdNode[] | null | undefined): string {
  if (node == null) return '';
  if (Array.isArray(node)) return joinOf(node as readonly MdNode[]);
  const n = node as MdNode;
  switch (n.type) {
    case 'text': case 'inlineCode': case 'code': return n.value;
    case 'image': return n.alt;
    case 'break': return ' ';
    case 'thematicBreak': return '';
    case 'details': return [inline(n.summary), joinOf(n.children)].filter(Boolean).join('\n\n');
    case 'tableRow': return n.children.map(text).join('\t');
    case 'table': case 'list': case 'listItem': case 'blockquote': case 'root': return joinOf(n.children);
    default: return inline(n.children);
  }
}

const inline = (nodes: readonly Inline[]) => nodes.map(text).join('');
function joinOf(nodes: readonly MdNode[]): string {
  // phrasing content runs together; blocks (and rows, items) are separated
  if (nodes.every((n) => INLINE.has(n.type))) return nodes.map(text).join('');
  const sep = nodes[0]?.type === 'tableRow' ? '\n' : '\n\n';
  return nodes.map(text).filter(Boolean).join(sep);
}
const INLINE = new Set(['text', 'emphasis', 'strong', 'delete', 'inlineCode', 'break', 'link', 'image', 'kbd', 'sub', 'sup', 'mark']);

/**
 * The anchor for a heading's text, as GitHub writes it: lower case, punctuation removed, spaces as
 * `-` (`Getting started!` → `getting-started`). `taken` holds the ids used so far in the document; a
 * repeated one gets `-1`, `-2`, ….
 */
export function slug(value: string, taken: Set<string>): string {
  const base = value.toLowerCase().trim().replace(/[^\p{L}\p{M}\p{N}\p{Pc} -]/gu, '').replace(/ /g, '-') || 'section';
  let id = base;
  for (let i = 1; taken.has(id); i++) id = `${base}-${i}`;
  taken.add(id);
  return id;
}
