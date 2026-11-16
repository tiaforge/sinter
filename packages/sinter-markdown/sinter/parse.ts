// `md.parse(source, options)`: markdown to the tree of sinter.types.ts. The parsing itself is the
// prebundled parser (parser.js, markdown-it); this module builds the tree from its tokens in one pass
// (no intermediate tree) and applies the options: what a document may contain is decided here, once per
// use, not by components that render nothing.
//
// Pure: the same source and options give the same tree, with no globals beyond the language's and
// `URL`. So sinter runs it at build time over a `file:` resource. In the browser a let or a prop is
// evaluated at every read, and md-doc's components read their `doc` at every node, so md.parse keeps
// its trees itself, with sinter's memo(): one parse per source and options, the tree frozen and shared
// (README.md, "md.parse keeps its trees").
// The parser by the package's own name, not `./parser.js`: an app makes it load on demand by listing
// this package in `sinter({ lazy })`, and lazy packages are matched by import specifier.
import { tokenize, type Token } from '@tiaforge-ui/sinter-markdown/parser';
import { memo } from '@tiaforge-ui/sinter/memo';
import { slug, text } from './tree.js';
import type { Block, Details, Heading, Inline, List, ListItem, ParseOptions, Root, Table, TableRow } from './sinter.types.js';

/**
 * The tree of `source` (CommonMark, and GFM tables, task lists, strikethrough and autolinks), under
 * `options`. The same source and options give the same tree, frozen: change a copy.
 */
export function parse(source: string | null | undefined, options?: ParseOptions): Root {
  // the options normalized to a plain object of primitives, so equal policies share one tree
  return parseTree(typeof source === 'string' ? source : '', optionsOf(options));
}

/** the parse itself, kept by its arguments (the least recently used trees go first, past 8 MiB) */
const parseTree = memo((source: string, o: Options): Root => ({ type: 'root', children: blocks(tokenize(source), { o, ids: new Set() }) }), { maxSize: 8 * 1024 * 1024 });

interface Options {
  base: string | null;
  headings: 'keep' | 'strong';
  images: 'keep' | 'link';
  html: 'drop' | 'text' | 'allow';
}
interface Context {
  o: Options;
  /** heading ids so far */
  ids: Set<string>;
}

const ONE_OF = { headings: ['keep', 'strong'], images: ['keep', 'link'], html: ['drop', 'text', 'allow'] } as const;
function optionsOf(options: ParseOptions | undefined): Options {
  const o = options ?? {};
  for (const [k, allowed] of Object.entries(ONE_OF)) {
    const v = (o as Record<string, unknown>)[k];
    if (v !== undefined && !(allowed as readonly unknown[]).includes(v)) throw new TypeError(`md.parse: \`${k}\` is ${allowed.map((a) => `'${a}'`).join(', ')}, not ${JSON.stringify(v)}`);
  }
  let base: string | null = null;
  if (o.base != null) {
    if (typeof o.base !== 'string' || !o.base.startsWith('/') || o.base.startsWith('//')) throw new TypeError(`md.parse: \`base\` is a folder from the project root, such as '/content/posts/', not ${JSON.stringify(o.base)}`);
    base = o.base.endsWith('/') ? o.base : o.base + '/';
  }
  return { base, headings: o.headings ?? 'keep', images: o.images ?? 'keep', html: o.html ?? 'text' };
}

/** a relative URL under `base`; absolute URLs, fragments, queries and links to markdown files as written */
function url(value: string, cx: Context, link: boolean): string {
  const base = cx.o.base;
  if (!base || !value || /^[a-z][a-z\d+.-]*:/i.test(value) || /^[/#?]/.test(value)) return value;
  if (link && /\.(md|markdown)(?:[?#]|$)/i.test(value)) return value;
  const u = new URL(value, 'http://root' + base);
  return u.pathname + u.search + u.hash;
}

// Block content -------------------------------------------------------------------------------------

/**
 * Where block content goes: the document, a blockquote or a list item. `open`: the `<details>` opened in it under
 * html: 'allow' and not closed yet (a details spans sibling blocks: an opening html block, blocks, a closing one);
 * a list item's `list`, and `first` until its first block (a task item's marker is in its first paragraph)
 */
interface Box { out: Block[]; open: Array<{ node: Details; out: Block[]; raw: string }>; list?: List; item?: ListItem; first?: boolean }

/** a GFM task list item: its first paragraph starts with `[ ]`, `[x]` or `[X]` and whitespace */
const TASK = /^\[([ xX])\][ \t]+/;

function blocks(tokens: readonly Token[], cx: Context): Block[] {
  const root: Box = { out: [], open: [] }, boxes = [root], lists: List[] = [];
  let box = root, list: List | null = null, table: Table | null = null, row: TableRow | null = null;
  const into = () => (box.open.length ? box.open[box.open.length - 1]!.node.children : box.out);
  const add = (b: Block) => { into().push(b); box.first = false; };
  const enter = (out: Block[], more?: Partial<Box>) => { boxes.push((box = { out, open: [], ...more })); };
  // a `<details>` left open is shown as written, its content after it
  const flush = () => { while (box.open.length) { const top = box.open.pop()!; top.out.push(rawBlock(top.raw), ...top.node.children); } };
  const leave = () => { flush(); boxes.pop(); box = boxes[boxes.length - 1]!; };
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!;
    switch (t.type) {
      case 'paragraph_open': {
        // markdown-it hides the paragraphs of a tight list's items: a visible one makes its list loose (as
        // mdast-util-to-hast renders it, every item's paragraphs are then <p>)
        if (box.list && !t.hidden) box.list.spread = true;
        let skip = 0;
        if (box.first && box.list) {
          // the marker: in the text the paragraph starts with
          const kids = tokens[i + 1]!.children ?? [];
          let lead = '';
          for (const k of kids) { const s = textOf(k); if (s == null) break; lead += s; }
          const m = TASK.exec(lead);
          if (m) { box.item!.checked = m[1] !== ' '; skip = m[0].length; }
        }
        const children = inlines(tokens[i + 1]!.children ?? [], cx, skip);
        if (children.length) add({ type: 'paragraph', children }); else box.first = false;
        i += 2;
        break;
      }
      case 'heading_open': {
        const children = inlines(tokens[i + 1]!.children ?? [], cx);
        add(cx.o.headings === 'strong' ? { type: 'paragraph', children: [{ type: 'strong', children }] }
          : { type: 'heading', depth: +t.tag.slice(1) as Heading['depth'], slug: slug(text(children), cx.ids), children });
        i += 2;
        break;
      }
      case 'blockquote_open': { const node: Block = { type: 'blockquote', children: [] }; add(node); enter(node.children); break; }
      case 'blockquote_close': case 'list_item_close': leave(); break;
      case 'bullet_list_open': case 'ordered_list_open': {
        const s = t.attrGet('start'), ordered = t.type === 'ordered_list_open';
        const node: List = { type: 'list', ordered, start: ordered ? (s == null ? 1 : +s) : null, spread: false, children: [] };
        add(node);
        lists.push((list = node));
        break;
      }
      case 'bullet_list_close': case 'ordered_list_close': lists.pop(); list = lists[lists.length - 1] ?? null; break;
      case 'list_item_open': {
        const item: ListItem = { type: 'listItem', checked: null, children: [] };
        list!.children.push(item);
        enter(item.children, { list: list!, item, first: true });
        break;
      }
      case 'table_open': add((table = { type: 'table', align: [], children: [] })); break;
      case 'tr_open': table!.children.push((row = { type: 'tableRow', children: [] })); break;
      case 'th_open': case 'td_open': {
        if (t.type === 'th_open') { const style = t.attrGet('style'); table!.align.push(style ? (/text-align:(\w+)/.exec(style)![1] as Table['align'][number]) : null); }
        row!.children.push({ type: 'tableCell', children: inlines(tokens[i + 1]!.children ?? [], cx) });
        i += 2;
        break;
      }
      case 'hr': add({ type: 'thematicBreak' }); break;
      case 'code_block': add({ type: 'code', lang: null, meta: null, value: t.content.replace(/\n$/, '') }); break;
      case 'fence': {
        const info = t.info.trim(), sp = info.search(/\s/);
        add({ type: 'code', lang: info ? (sp < 0 ? info : info.slice(0, sp)) : null, meta: sp < 0 ? null : info.slice(sp).trim() || null, value: t.content.replace(/\n$/, '') });
        break;
      }
      case 'html_block': {
        const value = t.content.replace(/\n+$/, '');
        box.first = false;
        if (cx.o.html === 'drop') break;
        if (cx.o.html === 'allow') {
          const d = DETAILS_OPEN.exec(value);
          if (d) {
            const node: Details = { type: 'details', open: d[1] != null, summary: d[2] != null ? summaryOf(d[2], cx) : [], children: [] };
            box.open.push({ node, out: into(), raw: value });
            break;
          }
          const s = SUMMARY.exec(value), top = box.open[box.open.length - 1];
          if (s && top && !top.node.summary.length && !top.node.children.length) { top.node.summary = summaryOf(s[1]!, cx); break; }
          if (DETAILS_CLOSE.test(value) && top) { box.open.pop(); top.out.push(top.node); break; }
        }
        into().push(rawBlock(value));
        break;
      }
      // definitions are resolved into their references by the parser; anything else has no component
    }
  }
  while (boxes.length > 1) leave();
  flush();
  return root.out;
}
const DETAILS_OPEN = /^<details(\s+open(?:\s*=\s*(?:""|''|"open"|'open'|open))?)?\s*>\s*(?:<summary>([\s\S]*?)<\/summary>)?\s*$/i;
const SUMMARY = /^<summary>([\s\S]*?)<\/summary>\s*$/i;
const DETAILS_CLOSE = /^<\/details\s*>\s*$/i;

/** raw HTML shown as written: a paragraph of its text */
const rawBlock = (value: string): Block => ({ type: 'paragraph', children: [{ type: 'text', value }] });

/** a summary's content, parsed as markdown and taken from its first paragraph */
function summaryOf(source: string, cx: Context): Inline[] {
  const t = tokenize(source);
  return t[0]?.type === 'paragraph_open' ? inlines(t[1]!.children ?? [], cx) : source.trim() ? [{ type: 'text', value: source.trim() }] : [];
}

// Phrasing content ----------------------------------------------------------------------------------

const ELEMENTS = ['kbd', 'sub', 'sup', 'mark'] as const;
type Element = (typeof ELEMENTS)[number];
const OPEN = /^<(kbd|sub|sup|mark)(?:\s[^<>]*)?>$/i;
const CLOSE = /^<\/(kbd|sub|sup|mark)\s*>$/i;

/** what a text-like token adds to its text run: a text, an entity, a soft break; null for any other */
const textOf = (t: Token): string | null => (t.type === 'text' || t.type === 'text_special' ? t.content : t.type === 'softbreak' ? '\n' : null);

/**
 * Phrasing content from an `inline` token's tokens, `skip` characters of its leading text left out (a task
 * item's marker). Adjacent text is one node, and empty text none: one text node per run in the page. Each
 * element (emphasis, a link) holds frames: under html: 'allow' an opening tag starts one that its closing
 * tag ends, and one left open is shown as written.
 */
function inlines(tokens: readonly Token[], cx: Context, skip = 0): Inline[] {
  type Frame = { tag: Element | null; raw: string; out: Inline[] };
  const out: Inline[] = [], stack: Frame[][] = [[{ tag: null, raw: '', out }]];
  let frames = stack[0]!, cur = out;
  const text = (v: string) => {
    if (!v) return;
    const last = cur[cur.length - 1];
    if (last?.type === 'text') last.value += v; else cur.push({ type: 'text', value: v });
  };
  const put = (n: Inline) => (n.type === 'text' ? text(n.value) : cur.push(n));
  const at = () => { cur = frames[frames.length - 1]!.out; };
  // a frame closed by its tag's end, or left open: its tag as written and its content, into the frame before
  const drop = () => { const f = frames.pop()!; at(); text(f.raw); for (const n of f.out) put(n); };
  const open = (n: Inline & { children: Inline[] }) => { cur.push(n); stack.push((frames = [{ tag: null, raw: '', out: n.children }])); cur = n.children; };
  const close = () => { while (frames.length > 1) drop(); stack.pop(); frames = stack[stack.length - 1]!; at(); };
  for (const t of tokens) {
    const s = textOf(t);
    if (s != null) {
      if (skip) { if (s.length <= skip) { skip -= s.length; continue; } text(s.slice(skip)); skip = 0; } else text(s);
      continue;
    }
    skip = 0;
    switch (t.type) {
      case 'hardbreak': cur.push({ type: 'break' }); break;
      case 'em_open': open({ type: 'emphasis', children: [] }); break;
      case 'strong_open': open({ type: 'strong', children: [] }); break;
      case 's_open': open({ type: 'delete', children: [] }); break;
      case 'link_open': open({ type: 'link', url: url(t.attrGet('href') ?? '', cx, true), title: t.attrGet('title') ?? null, children: [] }); break;
      case 'em_close': case 'strong_close': case 's_close': case 'link_close': close(); break;
      case 'code_inline': cur.push({ type: 'inlineCode', value: t.content }); break;
      case 'image': {
        const src = url(t.attrGet('src') ?? '', cx, false), title = t.attrGet('title') ?? null, alt = plain(t.children);
        cur.push(cx.o.images === 'link' ? { type: 'link', url: src, title, children: [{ type: 'text', value: alt || src }] } : { type: 'image', url: src, title, alt });
        break;
      }
      case 'html_inline': {
        const value = t.content;
        if (cx.o.html === 'drop') break;
        if (cx.o.html === 'allow') {
          const o = OPEN.exec(value);
          if (o) { frames.push({ tag: o[1]!.toLowerCase() as Element, raw: value, out: [] }); at(); break; }
          const c = CLOSE.exec(value);
          const k = c ? frames.findLastIndex((f) => f.tag === c[1]!.toLowerCase()) : -1;
          if (k > 0) {
            // frames opened inside it and never closed are shown as written
            while (frames.length - 1 > k) drop();
            const f = frames.pop()!;
            at();
            cur.push({ type: f.tag!, children: f.out });
            break;
          }
        }
        text(value);
        break;
      }
    }
  }
  while (frames.length > 1) drop();
  return out;
}

/** an image's alt: the text of its description, without markup */
function plain(tokens: readonly Token[] | null): string {
  let s = '';
  for (const t of tokens ?? []) {
    if (t.type === 'text' || t.type === 'text_special' || t.type === 'code_inline') s += t.content;
    else if (t.type === 'softbreak') s += '\n';
    else if (t.type === 'image') s += plain(t.children);
  }
  return s;
}
