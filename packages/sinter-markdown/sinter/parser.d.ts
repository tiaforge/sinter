// The prebundled parser (sinter/parser.js, built by scripts/build-parser.mjs).

/** a markdown-it token, for the parts md.parse reads */
export interface Token {
  type: string;
  /** the element: `h2` for a level-2 heading's tokens */
  tag: string;
  content: string;
  /** a fence's info string, unescaped */
  info: string;
  /** a paragraph of a tight list's item */
  hidden: boolean;
  /** an `inline` token's tokens; an image's description */
  children: Token[] | null;
  attrGet(name: string): string | null;
}

/** The block tokens of `source` (CommonMark, and GFM tables, strikethrough and autolinks), as markdown-it gives them. */
export function tokenize(source: string): Token[];
