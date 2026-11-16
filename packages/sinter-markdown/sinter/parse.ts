// `md.parse(source, options)`: markdown to the tree of sinter.types.ts. The parsing itself is the
// prebundled parser (parser.js); this module reduces its mdast to plain data the components render,
// and applies the options: what a document may contain is decided here, once per use, not by
// components that render nothing.
//
// Pure: the same source and options give the same tree, with no globals beyond the language's and
// `URL`. So sinter runs it at build time over a `file:` resource. In the browser a let or a prop is
// evaluated at every read, and md-doc's components read their `doc` at every node, so md.parse keeps
// its trees itself, with sinter's memo(): one parse per source and options, the tree frozen and shared
// (README.md, "md.parse keeps its trees").
// The parser by the package's own name, not `./parser.js`: an app makes it load on demand by listing
// this package in `sinter({ lazy })`, and lazy packages are matched by import specifier.
import { tokenize, type MdastNode } from '@tiaforge-ui/sinter-markdown/parser';
import { memo } from '@tiaforge-ui/sinter/memo';
import { slug, text } from './tree.js';
import type { Align, Block, Details, Heading, Inline, ListItem, ParseOptions, Root, TableCell, TableRow } from './sinter.types.js';

/**
 * The tree of `source` (CommonMark, and GFM tables, task lists, strikethrough and autolinks), under
 * `options`. The same source and options give the same tree, frozen: change a copy.
 */
export function parse(source: string | null | undefined, options?: ParseOptions): Root {
  // the options normalized to a plain object of primitives, so equal policies share one tree
  return parseTree(typeof source === 'string' ? source : '', optionsOf(options));
}

/** the parse itself, kept by its arguments (the least recently used trees go first, past 8 MiB) */
const parseTree = memo((source: string, o: Options): Root => {
  const tree = tokenize(source);
  const cx: Context = { o, ids: new Set(), defs: new Map() };
  collect(tree, cx.defs);
  return { type: 'root', children: blocks(tree.children ?? [], cx) };
}, { maxSize: 8 * 1024 * 1024 });

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
  /** definitions by identifier, for references */
  defs: Map<string, { url: string; title: string | null }>;
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

/** every definition in the tree; the first of an identifier wins, as CommonMark says */
function collect(n: MdastNode, defs: Context['defs']) {
  if (n.type === 'definition') {
    const id = String(n.identifier);
    if (!defs.has(id)) defs.set(id, { url: String(n.url ?? ''), title: (n.title as string | null) ?? null });
  }
  for (const c of n.children ?? []) collect(c, defs);
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

function blocks(nodes: readonly MdastNode[], cx: Context): Block[] {
  const out: Block[] = [];
  // `<details>` under html: 'allow' spans sibling nodes: an opening html block, blocks, a closing one
  const open: Array<{ node: Details; out: Block[]; raw: string }> = [];
  const into = () => (open.length ? open[open.length - 1]!.node.children : out);
  for (const n of nodes) {
    if (n.type === 'html') {
      const value = String(n.value ?? '');
      if (cx.o.html === 'drop') continue;
      if (cx.o.html === 'allow') {
        const d = DETAILS_OPEN.exec(value);
        if (d) {
          const node: Details = { type: 'details', open: d[1] != null, summary: d[2] != null ? summaryOf(d[2], cx) : [], children: [] };
          open.push({ node, out: into(), raw: value });
          continue;
        }
        const s = SUMMARY.exec(value);
        const top = open[open.length - 1];
        if (s && top && !top.node.summary.length && !top.node.children.length) { top.node.summary = summaryOf(s[1]!, cx); continue; }
        if (DETAILS_CLOSE.test(value) && top) { open.pop(); top.out.push(top.node); continue; }
      }
      into().push(rawBlock(value));
      continue;
    }
    const b = block(n, cx);
    if (b) into().push(b);
  }
  // a `<details>` left open is shown as written, its content after it
  while (open.length) {
    const top = open.pop()!;
    top.out.push(rawBlock(top.raw), ...top.node.children);
  }
  return out;
}
const DETAILS_OPEN = /^<details(\s+open(?:\s*=\s*(?:""|''|"open"|'open'|open))?)?\s*>\s*(?:<summary>([\s\S]*?)<\/summary>)?\s*$/i;
const SUMMARY = /^<summary>([\s\S]*?)<\/summary>\s*$/i;
const DETAILS_CLOSE = /^<\/details\s*>\s*$/i;

/** raw HTML shown as written: a paragraph of its text */
const rawBlock = (value: string): Block => ({ type: 'paragraph', children: [{ type: 'text', value }] });

/** a summary's content, parsed as markdown and taken from its first paragraph */
function summaryOf(source: string, cx: Context): Inline[] {
  const first = tokenize(source).children?.[0];
  return first && first.type === 'paragraph' ? inlines(first.children ?? [], cx) : source.trim() ? [{ type: 'text', value: source.trim() }] : [];
}

function block(n: MdastNode, cx: Context): Block | null {
  const kids = n.children ?? [];
  switch (n.type) {
    case 'paragraph': {
      const children = inlines(kids, cx);
      return children.length ? { type: 'paragraph', children } : null;
    }
    case 'heading': {
      const children = inlines(kids, cx);
      if (cx.o.headings === 'strong') return { type: 'paragraph', children: [{ type: 'strong', children }] };
      return { type: 'heading', depth: n.depth as Heading['depth'], slug: slug(text(children), cx.ids), children };
    }
    case 'thematicBreak': return { type: 'thematicBreak' };
    case 'blockquote': return { type: 'blockquote', children: blocks(kids, cx) };
    case 'list': {
      const items: ListItem[] = kids.map((i) => ({ type: 'listItem', checked: typeof i.checked === 'boolean' ? i.checked : null, children: blocks(i.children ?? [], cx) }));
      // loose when the list or any item is: then every item's paragraphs are <p>, as mdast-util-to-hast renders it
      const spread = !!n.spread || kids.some((i) => !!i.spread);
      return { type: 'list', ordered: !!n.ordered, start: n.ordered ? (typeof n.start === 'number' ? n.start : 1) : null, spread, children: items };
    }
    case 'code': return { type: 'code', lang: (n.lang as string | null) ?? null, meta: (n.meta as string | null) ?? null, value: String(n.value ?? '') };
    case 'table': {
      const align = ((n.align as Align[] | undefined) ?? []).map((a) => a ?? null);
      const rows: TableRow[] = kids.map((r) => ({ type: 'tableRow', children: (r.children ?? []).map((c): TableCell => ({ type: 'tableCell', children: inlines(c.children ?? [], cx) })) }));
      return { type: 'table', align, children: rows };
    }
    // definitions are resolved into their references; anything else has no component
    default: return null;
  }
}

// Phrasing content ----------------------------------------------------------------------------------

const ELEMENTS = ['kbd', 'sub', 'sup', 'mark'] as const;
type Element = (typeof ELEMENTS)[number];
const OPEN = /^<(kbd|sub|sup|mark)(?:\s[^<>]*)?>$/i;
const CLOSE = /^<\/(kbd|sub|sup|mark)\s*>$/i;

function inlines(nodes: readonly MdastNode[], cx: Context): Inline[] {
  // under html: 'allow', an opening tag starts a frame that its closing tag ends
  const frames: Array<{ tag: Element | null; raw: string; out: Inline[] }> = [{ tag: null, raw: '', out: [] }];
  const push = (x: Inline | Inline[]) => frames[frames.length - 1]!.out.push(...(Array.isArray(x) ? x : [x]));
  for (const n of nodes) {
    if (n.type === 'html') {
      const value = String(n.value ?? '');
      if (cx.o.html === 'drop') continue;
      if (cx.o.html === 'allow') {
        const o = OPEN.exec(value);
        if (o) { frames.push({ tag: o[1]!.toLowerCase() as Element, raw: value, out: [] }); continue; }
        const c = CLOSE.exec(value);
        const at = c ? frames.findLastIndex((f) => f.tag === c[1]!.toLowerCase()) : -1;
        if (at > 0) {
          // frames opened inside it and never closed are shown as written
          while (frames.length - 1 > at) { const f = frames.pop()!; push([{ type: 'text', value: f.raw }, ...f.out]); }
          const f = frames.pop()!;
          push({ type: f.tag!, children: merge(f.out) });
          continue;
        }
      }
      push({ type: 'text', value });
      continue;
    }
    push(inline(n, cx));
  }
  while (frames.length > 1) { const f = frames.pop()!; push([{ type: 'text', value: f.raw }, ...f.out]); }
  return merge(frames[0]!.out);
}

/** adjacent text runs as one, empty ones dropped: one text node per run in the page */
function merge(nodes: Inline[]): Inline[] {
  const out: Inline[] = [];
  for (const n of nodes) {
    const last = out[out.length - 1];
    if (n.type === 'text') {
      if (!n.value) continue;
      if (last?.type === 'text') { out[out.length - 1] = { type: 'text', value: last.value + n.value }; continue; }
    }
    out.push(n);
  }
  return out;
}

function inline(n: MdastNode, cx: Context): Inline[] {
  const kids = () => inlines(n.children ?? [], cx);
  switch (n.type) {
    case 'text': return [{ type: 'text', value: String(n.value ?? '') }];
    case 'emphasis': return [{ type: 'emphasis', children: kids() }];
    case 'strong': return [{ type: 'strong', children: kids() }];
    case 'delete': return [{ type: 'delete', children: kids() }];
    case 'inlineCode': return [{ type: 'inlineCode', value: String(n.value ?? '') }];
    case 'break': return [{ type: 'break' }];
    case 'link': return [{ type: 'link', url: url(String(n.url ?? ''), cx, true), title: (n.title as string | null) ?? null, children: kids() }];
    case 'linkReference': {
      const d = cx.defs.get(String(n.identifier));
      return d ? [{ type: 'link', url: url(d.url, cx, true), title: d.title, children: kids() }] : kids();
    }
    case 'image': case 'imageReference': {
      const d = n.type === 'image' ? { url: String(n.url ?? ''), title: (n.title as string | null) ?? null } : cx.defs.get(String(n.identifier));
      const alt = String(n.alt ?? '');
      if (!d) return alt ? [{ type: 'text', value: alt }] : [];
      const src = url(d.url, cx, false);
      if (cx.o.images === 'link') return [{ type: 'link', url: src, title: d.title, children: [{ type: 'text', value: alt || src }] }];
      return [{ type: 'image', url: src, title: d.title, alt }];
    }
    default: return kids();
  }
}
