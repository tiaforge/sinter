// The tree `md.parse` returns and the md-* components render: mdast (https://github.com/syntax-tree/mdast),
// reduced to what the components draw. Every node is plain data (no positions, no `data`), so a tree
// folds at build time, travels as JSON from an API, and is checked by `type` in markup:
// `{ paragraph: 'md-paragraph', heading: 'md-heading' }[node.type]`.
//
// Where it differs from mdast:
// - definitions are resolved: `linkReference` and `imageReference` are `link` and `image`;
// - a heading has a `slug`, and its anchor is `md-` + slug, the id `md.headings` lists;
// - a list's `spread` is whether it renders loose (`<p>` in its items), as mdast-util-to-hast decides it;
// - raw HTML is never an `html` node: it is text, dropped, or one of the elements `html: 'allow'` keeps
//   (`kbd`, `sub`, `sup`, `mark`, `details`).

/** a parsed document */
export interface Root {
  type: 'root';
  children: Block[];
}

/** block content: what `md-doc` renders */
export type Block = Paragraph | Heading | ThematicBreak | Blockquote | List | Code | Table | Details;

/** phrasing content: the inside of a paragraph, a heading, a table cell */
export type Inline = Text | Emphasis | Strong | Delete | InlineCode | Break | Link | Image | Kbd | Sub | Sup | Mark;

/** any node of the tree */
export type MdNode = Root | Block | Inline | ListItem | TableRow | TableCell;

export interface Paragraph {
  type: 'paragraph';
  children: Inline[];
}

export interface Heading {
  type: 'heading';
  depth: 1 | 2 | 3 | 4 | 5 | 6;
  /**
   * From the heading's text (`## Getting started` → `getting-started`), unique in the document. The
   * heading's anchor is `md-` + slug (`id="md-getting-started"`), the id `md.headings` gives: an id
   * written from data starts with a literal, so it cannot clobber a global (sinter's SN503).
   */
  slug: string;
  children: Inline[];
}

export interface ThematicBreak {
  type: 'thematicBreak';
}

export interface Blockquote {
  type: 'blockquote';
  children: Block[];
}

export interface List {
  type: 'list';
  ordered: boolean;
  /** the first number of an ordered list, null for an unordered one */
  start: number | null;
  /** loose: its items' paragraphs render as `<p>` */
  spread: boolean;
  children: ListItem[];
}

export interface ListItem {
  type: 'listItem';
  /** a task: `[x]` is true, `[ ]` false; null when the item is no task */
  checked: boolean | null;
  children: Block[];
}

export interface Code {
  type: 'code';
  /** the info string's first word (` ```ts ` → `ts`), or null */
  lang: string | null;
  /** the rest of the info string, or null */
  meta: string | null;
  value: string;
}

export type Align = 'left' | 'right' | 'center' | null;

export interface Table {
  type: 'table';
  /** per column */
  align: Align[];
  /** the first row is the header */
  children: TableRow[];
}

export interface TableRow {
  type: 'tableRow';
  children: TableCell[];
}

export interface TableCell {
  type: 'tableCell';
  children: Inline[];
}

/** `<details>` with its `<summary>`, from raw HTML under `html: 'allow'` */
export interface Details {
  type: 'details';
  open: boolean;
  /** the summary's content; empty when there is no `<summary>` */
  summary: Inline[];
  children: Block[];
}

export interface Text {
  type: 'text';
  value: string;
}

export interface Emphasis {
  type: 'emphasis';
  children: Inline[];
}

export interface Strong {
  type: 'strong';
  children: Inline[];
}

/** `~~strikethrough~~` */
export interface Delete {
  type: 'delete';
  children: Inline[];
}

export interface InlineCode {
  type: 'inlineCode';
  value: string;
}

/** a hard line break */
export interface Break {
  type: 'break';
}

export interface Link {
  type: 'link';
  url: string;
  title: string | null;
  children: Inline[];
}

export interface Image {
  type: 'image';
  url: string;
  title: string | null;
  alt: string;
}

/** `<kbd>`, under `html: 'allow'` */
export interface Kbd {
  type: 'kbd';
  children: Inline[];
}

/** `<sub>`, under `html: 'allow'` */
export interface Sub {
  type: 'sub';
  children: Inline[];
}

/** `<sup>`, under `html: 'allow'` */
export interface Sup {
  type: 'sup';
  children: Inline[];
}

/** `<mark>`, under `html: 'allow'` */
export interface Mark {
  type: 'mark';
  children: Inline[];
}

/** What a document may contain: the policy for one use of `md.parse` */
export interface ParseOptions {
  /**
   * A folder from the project root (`/content/posts/`): relative image and link URLs become root
   * paths under it (`./diagram.png` → `/content/posts/diagram.png`), so the image pipeline finds a
   * file next to the markdown. Links to other `.md` files, `#fragments` and absolute URLs stay as
   * written. Leave it out for markdown from an API.
   */
  base?: string;
  /** `'keep'` (default), or `'strong'`: every heading becomes a paragraph of strong text, so the tree has none */
  headings?: 'keep' | 'strong';
  /** `'keep'` (default), or `'link'`: every image becomes a link to it, its text the alt text */
  images?: 'keep' | 'link';
  /**
   * Raw HTML in the source, which is never markup: `'text'` (default) shows it as written, `'drop'`
   * removes it, `'allow'` keeps `<kbd>`, `<sub>`, `<sup>`, `<mark>` and `<details>` with `<summary>`
   * (only `open` of their attributes) and shows the rest as written.
   */
  html?: 'drop' | 'text' | 'allow';
}

/** one entry of `md.headings`: a table of contents */
export interface TocEntry {
  depth: 1 | 2 | 3 | 4 | 5 | 6;
  /** the heading's anchor, as `md-doc` writes it: `md-` + its slug */
  id: string;
  /** its plain text */
  text: string;
}
