// Completion in a `data-sn-for` value, which is not one expression: `item in list` or `(item, i) in list`.
// Before `in`, the syntax and the lists in scope, each with an item name made from it (`contact in contacts`);
// after `in`, TypeScript's names with the lists first.
import { attrValueAt } from './markup.js';

/** Where an offset is in a `data-sn-for` value: the value's range, and which part is being typed. */
export type ForPlace =
  /** the item (`co▮`, `(c, ▮`, or nothing yet); `from`–`to` is what an item replaces */
  | { part: 'item'; value: { from: number; to: number }; from: number; to: number }
  /** after the item, where `in` goes (`c ▮`, `c i▮`); `from`–`to` is what an item replaces */
  | { part: 'in'; value: { from: number; to: number }; from: number; to: number }
  /** the list, after `in`: an expression */
  | { part: 'list'; value: { from: number; to: number } };

const ID = '[A-Za-z_]\\w*';
const ITEM = new RegExp(`^\\s*(?:\\(\\s*${ID}\\s*,\\s*${ID}\\s*\\)|${ID})`);
const HEAD = new RegExp(`${ITEM.source}\\s+in\\s`);

/** Where the 0-based offset is in a `data-sn-for` value, or null when it is in none. */
export function forPlace(text: string, offset: number): ForPlace | null {
  const at = attrValueAt(text, offset, 'data-sn-for');
  if (!at || at.el.tagName !== 'template') return null;
  const value = { from: at.from, to: at.to };
  const typed = text.slice(at.from, offset);
  if (HEAD.test(typed)) return { part: 'list', value };
  // an item replaces the value up to its end, when nothing but space follows the offset
  const rest = text.slice(offset, at.to);
  const lead = typed.length - typed.trimStart().length;
  if (/^\s*$/.test(rest) && new RegExp(`^\\s*(?:\\(\\s*(?:${ID}\\s*(?:,\\s*(?:${ID}\\s*\\)?)?)?)?|${ID})?$`).test(typed)) {
    return { part: 'item', value, from: at.from + lead, to: at.to };
  }
  const item = ITEM.exec(typed);
  const word = item && /^(\s+)(i|in)?$/.exec(typed.slice(item[0].length));
  if (word && /^\s*$/.test(rest)) return { part: 'in', value, from: offset - (word[2]?.length ?? 0), to: at.to };
  return null;
}

const RESERVED = new Set(['new', 'in', 'do', 'if', 'for', 'var', 'let', 'case', 'this', 'with', 'class', 'const', 'delete', 'typeof', 'void', 'null', 'true', 'false']);

/** The name of one item of a list named `list`: `contacts` → `contact`, `entries` → `entry`, `tagSet` → `tag`; else `item`. */
export function itemName(list: string): string {
  const base = list.replace(/(?<=[a-z0-9])(?:List|Set|Array|Items)$/, '');
  if (base !== list) return base;
  const one = /ies$/.test(list) ? list.slice(0, -3) + 'y'
    : /(?:ss|sh|ch|x|z)es$/.test(list) ? list.slice(0, -2)
    : /[^su]s$/.test(list) ? list.slice(0, -1)
    : '';
  return one && !RESERVED.has(one) ? one : 'item';
}

/**
 * Whether a type as TypeScript prints it (a completion's detail, `let items: number[]`) is one `data-sn-for` repeats
 * over: true for arrays and iterables, false for functions and other values, null when the text does not say.
 */
export function listType(detail: string): boolean | null {
  // `const x: T`, `(property) x?: T`; `function f(…)` and `(method) f(…)` are no lists
  const m = /^(?:\([\w ]+\)\s*)?(?:(?:const|let|var)\s+)?[\w$]+\s*(\??:)?\s*([\s\S]*)$/.exec(detail.trim());
  if (!m || !m[1]) return false;
  const t = m[2]!.replace(/\s*\|\s*(?:null|undefined)\b/g, '').trim();
  if (/\[\]$|^readonly\s|^\[/.test(t) || /^(?:Readonly)?Array<|^ReadonlyArray<|^(?:Readonly)?(?:Set|Map)<|^(?:Async)?Iterable(?:Iterator)?<|^Generator</.test(t)) return true;
  // functions (`(…) => …`, `<T>(…) => …`), primitives, objects, elements
  if (/^[<({"'`\d]|^(?:string|number|boolean|bigint|symbol|Date|RegExp|Record<|Partial<)|^(?:HTML|SVG)?\w*Element\b/.test(t)) return false;
  return null;
}

/** An item for the `in` or item part: a list, written `item in list`. */
export interface LoopItem { label: string; detail: string; insert: string; snippet: boolean; sortText: string; from: number; to: number; kind: number }

/**
 * The items before `in`: in the item part, `item in list` and `(item, i) in list` (snippets when the client takes
 * them) and `contact in contacts` per list; in the `in` part, `in` and `in contacts` per list.
 */
export function loopItems(place: Extract<ForPlace, { part: 'item' | 'in' }>, lists: string[], snippets: boolean): LoopItem[] {
  const { from, to } = place;
  const out: LoopItem[] = [];
  if (place.part === 'item') {
    lists.forEach((l, k) => {
      const one = itemName(l);
      const sort = String(k).padStart(3, '0');
      out.push({ label: `${one} in ${l}`, detail: `repeat for each of ${l}`, insert: `${one} in ${l}`, snippet: false, sortText: `0${sort}a`, from, to, kind: 15 });
      out.push({ label: `(${one}, i) in ${l}`, detail: `repeat for each of ${l}, with its index`, insert: snippets ? `(${one}, \${1:i}) in ${l}` : `(${one}, i) in ${l}`, snippet: snippets, sortText: `0${sort}b`, from, to, kind: 15 });
    });
    out.push({ label: 'item in list', detail: 'data-sn-for', insert: snippets ? '${1:item} in ${2:list}' : 'item in list', snippet: snippets, sortText: '1a', from, to, kind: 15 });
    out.push({ label: '(item, i) in list', detail: 'data-sn-for, with the index', insert: snippets ? '(${1:item}, ${2:i}) in ${3:list}' : '(item, i) in list', snippet: snippets, sortText: '1b', from, to, kind: 15 });
    return out;
  }
  out.push({ label: 'in', detail: 'data-sn-for', insert: 'in ', snippet: false, sortText: '1', from, to, kind: 14 });
  lists.forEach((l, k) => out.push({ label: `in ${l}`, detail: `repeat for each of ${l}`, insert: `in ${l}`, snippet: false, sortText: `0${String(k).padStart(3, '0')}`, from, to, kind: 15 }));
  return out;
}
