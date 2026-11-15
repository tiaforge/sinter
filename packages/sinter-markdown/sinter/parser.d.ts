// The prebundled parser (sinter/parser.js, built by scripts/build-parser.mjs).

/** a node as mdast-util-from-markdown returns it, before `md.parse` reduces it to sinter.types.ts */
export interface MdastNode {
  type: string;
  children?: MdastNode[];
  value?: string;
  [key: string]: unknown;
}

/** The mdast tree of `source`: CommonMark, and GFM tables, task lists, strikethrough and autolinks. */
export function tokenize(source: string): MdastNode;
