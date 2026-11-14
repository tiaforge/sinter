// What the language server knows about a page's markup without TypeScript: the slots of the
// component or layout a tag uses (completion of `slot="…"`, go to its `<slot>`), the components and
// layouts a tag can name (completion after `<`), and a tag's contract (hover).
import * as parse5 from 'parse5';
import type { DefaultTreeAdapterMap } from 'parse5';
import { parseDocument } from '../compiler/head.js';

type P5Node = DefaultTreeAdapterMap['node'];
type P5Element = DefaultTreeAdapterMap['element'];
type P5Parent = DefaultTreeAdapterMap['parentNode'];
type P5Template = DefaultTreeAdapterMap['template'];

/** What a tag names: a component (for the body), a head component, or a layout; its file and text. */
export interface TagFile { kind: 'component' | 'head' | 'layout'; file: string; text: string }

/** A slot of a component or layout: its name ('' for the default slot), whether it is in a head, its fallback, where it is. */
export interface SlotInfo { name: string; head: boolean; fallback: string; line: number; col: number }

const HEAD_ELEMENTS = new Set(['title', 'meta', 'link', 'base', 'script', 'style', 'noscript']);
const isElement = (n: P5Node): n is P5Element => 'tagName' in n;
const attr = (el: P5Element, name: string) => el.attrs.find((a) => a.name === name)?.value;

/** The slots of a component or layout file, in document order. */
export function slotsOf(t: TagFile): SlotInfo[] {
  const out: SlotInfo[] = [];
  const doc = t.kind === 'layout' ? parseDocument(t.text) : parse5.parseFragment(t.text, { sourceCodeLocationInfo: true });
  const lines = lineStarts(t.text);
  const walk = (n: P5Parent, head: boolean) => {
    for (const c of n.childNodes) {
      if (!isElement(c)) continue;
      const inHead = head || c.tagName === 'head';
      if (c.tagName === 'slot') {
        const at = c.sourceCodeLocation?.startOffset ?? 0;
        const { line, col } = position(lines, at);
        const fallback = t.text.slice(c.sourceCodeLocation?.startTag?.endOffset ?? at, c.sourceCodeLocation?.endTag?.startOffset ?? at).trim();
        out.push({ name: attr(c, 'name') ?? '', head: inHead || t.kind === 'head', fallback, line, col });
      }
      walk(c, inHead);
      if (c.tagName === 'template') walk((c as P5Template).content, inHead);
    }
  };
  walk(doc, false);
  return out;
}

/** The props a component or layout declares, as written. */
export function propsOf(t: TagFile): string {
  const m = (t.kind === 'layout' ? /\sdata-sn-layout\s*=\s*"([^"]*)"/ : t.kind === 'head' ? /\sdata-sn-head\s*=\s*"([^"]*)"/ : /\sdata-sn-component\s*=\s*"([^"]*)"/).exec(t.text);
  return m?.[1]?.trim() || '{}';
}

/** The element a 0-based offset is in (the deepest one whose source range holds it), and its parent element. */
export function elementAt(text: string, offset: number): { el: P5Element; parent: P5Element | null } | null {
  const doc = parseDocument(text);
  let best: { el: P5Element; parent: P5Element | null } | null = null;
  const walk = (n: P5Parent, parent: P5Element | null) => {
    for (const c of n.childNodes) {
      if (!isElement(c)) continue;
      const loc = c.sourceCodeLocation;
      const end = loc?.endTag?.endOffset ?? loc?.endOffset ?? -1;
      if (loc && offset >= loc.startOffset && offset <= end) best = { el: c, parent };
      walk(c, c);
      if (c.tagName === 'template') walk((c as P5Template).content, c);
    }
  };
  walk(doc, null);
  return best;
}

/** The value of `slot="…"` the offset is in: the element, the text typed so far and its range. */
export function slotValueAt(text: string, offset: number): { parentTag: string; tag: string; typed: string; from: number; to: number } | null {
  const hit = elementAt(text, offset);
  if (!hit) return null;
  const a = hit.el.sourceCodeLocation?.attrs?.slot;
  if (!a || offset < a.startOffset || offset > a.endOffset) return null;
  const raw = text.slice(a.startOffset, a.endOffset);
  const q = raw.search(/["']/);
  if (q < 0) return null;
  const from = a.startOffset + q + 1;
  const close = raw.slice(q + 1).search(/["']/);
  const to = close < 0 ? a.endOffset : from + close;
  if (offset < from || offset > to) return null;
  // the tag whose content this is: its parent, or for a page that is a layout's tag, that tag
  const parent = hit.parent && hit.parent.tagName !== 'body' && hit.parent.tagName !== 'head' ? hit.parent : null;
  if (!parent) return null;
  return { parentTag: parent.tagName, tag: hit.el.tagName, typed: text.slice(from, offset), from, to };
}

/**
 * Completion items for a `slot="…"` value: the slots of the tag the element is in. A head element
 * (`<title>`, `<meta>`, …) is offered the head slots, any other element the others.
 */
export function slotCompletions(text: string, offset: number, resolve: (tag: string) => TagFile | null): Array<{ label: string; detail: string; documentation?: string; from: number; to: number }> | null {
  const at = slotValueAt(text, offset);
  if (!at) return null;
  const t = resolve(at.parentTag);
  if (!t) return null;
  const headEl = HEAD_ELEMENTS.has(at.tag);
  return slotsOf(t).filter((s) => s.name && (t.kind !== 'layout' || s.head === headEl)).map((s) => ({
    label: s.name,
    detail: `${t.kind === 'layout' ? (s.head ? 'head slot' : 'body slot') : 'slot'} of <${at.parentTag}>`,
    ...(s.fallback ? { documentation: `Fallback:\n\n\`\`\`html\n${s.fallback}\n\`\`\`` } : {}),
    from: at.from, to: at.to,
  }));
}

/** The `<slot name>` a `slot="…"` value names, in the file of the tag the element is in. */
export function slotDefinition(text: string, offset: number, resolve: (tag: string) => TagFile | null): { file: string; line: number; col: number } | null {
  const at = slotValueAt(text, offset);
  if (!at) return null;
  const t = resolve(at.parentTag);
  if (!t) return null;
  const name = text.slice(at.from, at.to);
  const s = slotsOf(t).find((x) => x.name === name);
  return s ? { file: t.file, line: s.line, col: s.col } : null;
}

/**
 * Completion items after `<` in an element's place: at the top of an empty page, the layouts; in a
 * head, the head components; elsewhere, the components. Null when the offset is not after `<name`.
 */
export function tagCompletions(text: string, offset: number, names: Array<{ name: string } & Omit<TagFile, 'text'>>): Array<{ label: string; detail: string; from: number; to: number }> | null {
  const before = text.slice(0, offset);
  const m = /<([a-z][a-z0-9-]*)?$/.exec(before);
  if (!m) return null;
  const from = offset - (m[1]?.length ?? 0);
  const rest = before.slice(0, m.index);
  const top = /^\s*(<!doctype[^>]*>\s*)?(<!--[\s\S]*?-->\s*)*$/i.test(rest);
  const inHead = /<head[\s>]/i.test(rest) && !/<\/head\s*>/i.test(rest) || /\sdata-sn-head\s*=/.test(rest);
  const kinds: Array<TagFile['kind']> = top ? ['layout'] : inHead ? ['head'] : ['component'];
  return names.filter((n) => kinds.includes(n.kind)).map((n) => ({ label: n.name, detail: n.kind === 'layout' ? 'layout' : n.kind === 'head' ? 'head component' : 'component', from, to: offset }));
}

/** Markdown for a hover on a component's or layout's tag: what it is, its props and its slots. */
export function tagHover(tag: string, t: TagFile, rel: string): string {
  const slots = slotsOf(t);
  const kind = t.kind === 'layout' ? 'layout' : t.kind === 'head' ? 'head component' : 'component';
  const list = slots.map((s) => `- ${s.name ? `\`${s.name}\`` : 'default'}${t.kind === 'layout' ? ` (${s.head ? 'head' : 'body'})` : ''}${s.fallback ? ', with fallback' : ''}`);
  return [`**\`<${tag}>\`** ${kind} · \`${rel}\``, '', `Props: \`${propsOf(t)}\``, '', slots.length ? `Slots:\n${list.join('\n')}` : 'No slots'].join('\n');
}

function lineStarts(text: string): number[] {
  const s = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === '\n') s.push(i + 1);
  return s;
}

function position(starts: number[], offset: number): { line: number; col: number } {
  let lo = 0, hi = starts.length - 1;
  while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (starts[mid]! <= offset) lo = mid; else hi = mid - 1; }
  return { line: lo + 1, col: offset - starts[lo]! + 1 };
}

/** The 0-based offset of a 0-based line and character. */
export function offsetOf(text: string, line: number, character: number): number {
  const starts = lineStarts(text);
  return Math.min((starts[line] ?? text.length) + character, text.length);
}
