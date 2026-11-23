/**
 * SPIKE (docs/proposals/static-trees.md): a component instance over build-time constants rendered straight to
 * markup, without the compiler's expansion, its two passes and their instance keys.
 *
 * `renderStatic` interprets a component and every component it renders over values it is handed, and returns the
 * nodes the full compile would write into the page, or null the moment anything is not plainly static: a name that is
 * not a constant, an attribute it does not know, a fill, a component with a script or styles, a value the first paint
 * could not write. Null means "compile it the usual way", so the fast path only ever takes what it fully understands.
 */
import * as parse5 from 'parse5';
import type { DefaultTreeAdapterMap } from 'parse5';
import { declaringTemplate } from './head.js';
import { typeMembers } from './components.js';

type P5Node = DefaultTreeAdapterMap['node'];
type P5Element = DefaultTreeAdapterMap['element'];
type P5Parent = DefaultTreeAdapterMap['parentNode'];
type P5Template = DefaultTreeAdapterMap['template'];

/** what the interpreter needs of a component file (the compiler's `ComponentFile`) */
export interface StaticDef {
  file: string;
  text: string;
  bad?: true;
  head?: boolean;
  either?: boolean;
  internal?: boolean;
  css?: string | null;
  rawCss?: string;
  cssText?: string;
  script?: string | null;
  inline?: unknown[];
  early?: string | null;
}

export interface StaticContext {
  componentFile(tag: string): StaticDef | null;
  /** the components `<sn-component use>` may choose among in a file's markup */
  pool(file: string): string[];
  /** helpers and namespaces as the build-time evaluator calls them: a call that may not fold throws */
  helpers: Map<string, unknown>;
  /** `[kind, value]` the first paint writes, or `fail` (the compiler's `firstPaintValue`) */
  paintValue(el: P5Element, kind: 'text' | 'attr' | 'class', name: string | null, v: unknown): [string, unknown] | symbol;
  fail: symbol;
  write(el: P5Element, kind: string, name: string | null, v: unknown): void;
  /** an element whose `src` or `srcset` the tree wrote: relative to the page, as a folded URL is */
  urlWritten(el: P5Element): void;
  /** most component instances and rows one tree may expand */
  limit: number;
  /** an element that is a component's root, by the innermost component's name: marked `data-sn-c` where the page marks roots */
  root(el: P5Element, name: string): void;
}

/** thrown to give up on the tree: it is compiled the usual way */
const BAIL = Symbol('static tree: not plainly static');

/** what an expression may read besides its scope: ECMAScript's deterministic globals, as a helper that folds may */
const GLOBALS = new Set(['Math', 'JSON', 'Array', 'Object', 'String', 'Number', 'Boolean', 'parseInt', 'parseFloat', 'isNaN', 'isFinite',
  'encodeURIComponent', 'decodeURIComponent', 'encodeURI', 'decodeURI', 'URL', 'URLSearchParams', 'structuredClone', 'undefined', 'NaN', 'Infinity', 'Map', 'Set']);

/** the attributes the interpreter knows; any other `data-sn-*` gives up */
const ELEMENT_ATTRS = new Set(['data-sn-attr', 'data-sn-class', 'data-sn-text']);

/** an element the tree made: how many of its attributes are its markup's own, before those the tree wrote */
export const OWN_ATTRS: WeakMap<object, number> = new WeakMap();

const fnCache = new Map<string, (s: object) => unknown>();
const parsedCache = new Map<string, DefaultTreeAdapterMap['documentFragment']>();

/** a scope: a chain of frames; a name in none of them that is not an allowed global gives up */
class Scope {
  constructor(readonly vars: Map<string, unknown>, readonly up: Scope | null) {}
  lookup(k: string): { v: unknown } | null {
    for (let s: Scope | null = this; s; s = s.up) if (s.vars.has(k)) return { v: s.vars.get(k) };
    return null;
  }
  child(vars: Map<string, unknown>): Scope { return new Scope(vars, this); }
}

function evaluate(expr: string, scope: Scope): unknown {
  let f = fnCache.get(expr);
  if (!f) {
    try { f = new Function('$s', `with ($s) { return (${expr}\n); }`) as (s: object) => unknown; } catch { throw BAIL; }
    fnCache.set(expr, f);
  }
  const proxy = new Proxy(Object.create(null) as object, {
    has: (_, k) => typeof k === 'string',
    get: (_, k) => {
      if (typeof k !== 'string') return undefined;
      const hit = scope.lookup(k);
      if (hit) return hit.v;
      if (GLOBALS.has(k)) return (globalThis as Record<string, unknown>)[k];
      throw BAIL;
    },
    set: () => { throw BAIL; },
  });
  try { return f(proxy); } catch { throw BAIL; }
}

const isElement = (n: P5Node): n is P5Element => 'tagName' in n;
const attrOf = (el: P5Element, name: string) => el.attrs.find((a) => a.name === name)?.value;
const blank = (n: P5Node) => n.nodeName === '#text' && !(n as DefaultTreeAdapterMap['textNode']).value.trim();
const real = (n: P5Node) => !blank(n) && n.nodeName !== '#comment';

function parsed(text: string) {
  let f = parsedCache.get(text);
  if (!f) { f = parse5.parseFragment(text); parsedCache.set(text, f); }
  return f;
}

class Renderer {
  count = 0;
  constructor(readonly ctx: StaticContext, readonly where: P5Element['sourceCodeLocation']) {}

  /** a component tag's instance: its markup over `props`, with no fills */
  component(name: string, props: unknown, host: P5Element | null): P5Node[] {
    const def = this.ctx.componentFile(name);
    // scoped styles mark the component's root (`data-sn-c`) and ship a sheet: not taken (yet). `css` is filled in only as
    // a use expands, so the file's own `<style>` is looked for here
    if (!def || def.bad || def.head || def.either || def.css || def.rawCss || def.cssText || /<style[\s>]/i.test(def.text) || def.script || def.inline?.length || def.early) throw BAIL;
    if (!props || typeof props !== 'object' || Array.isArray(props)) throw BAIL;
    // fills, and attributes the tag passes to the root: not taken (yet)
    if (host && host.childNodes.some(real)) throw BAIL;
    if (++this.count > this.ctx.limit) throw BAIL;
    const t = declaringTemplate(parsed(def.text).childNodes) as P5Template | null;
    if (!t) throw BAIL;
    // a declared prop the use does not pass reads `undefined`; a slot prop is not a value
    const members = typeMembers(attrOf(t, 'data-sn-props') ?? '{}');
    if (!members) throw BAIL;
    const vars = new Map<string, unknown>(members.filter((m) => !m.slot).map((m) => [m.name, undefined]));
    for (const [k, v] of Object.entries(props)) vars.set(k, v);
    vars.set('$build', true);
    vars.set('$slots', Object.freeze({}));
    for (const [k, v] of this.ctx.helpers) if (!vars.has(k)) vars.set(k, v);
    const out = this.nodes(t.content.childNodes, new Scope(vars, null), def.file).filter((n) => !blank(n));
    // its roots: the elements it renders at its top (an inner component's root is its own first: innermost wins)
    for (const n of out) if (isElement(n)) this.ctx.root(n, name);
    return out;
  }

  nodes(list: readonly P5Node[], scope: Scope, file: string): P5Node[] {
    const out: P5Node[] = [];
    for (let i = 0; i < list.length; i++) {
      const n = list[i]!;
      if (!isElement(n)) {
        if (n.nodeName === '#text') out.push({ nodeName: '#text', value: (n as DefaultTreeAdapterMap['textNode']).value, parentNode: null } as unknown as P5Node);
        else if (n.nodeName === '#comment') out.push({ nodeName: '#comment', data: (n as DefaultTreeAdapterMap['commentNode']).data, parentNode: null } as unknown as P5Node);
        continue;
      }
      if (n.tagName === 'template') { i = this.template(list, i, scope, file, out); continue; }
      if (n.tagName === 'slot') { out.push(...this.nodes(n.childNodes, scope, file)); continue; }
      if (n.tagName === 'sn-component') {
        if (n.attrs.some((a) => a.name !== 'use' && a.name !== 'data-sn-with')) throw BAIL;
        const name = evaluate(attrOf(n, 'use') ?? '', scope);
        if (typeof name !== 'string' || !this.ctx.pool(file).includes(name)) throw BAIL;
        out.push(...this.component(name, evaluate(attrOf(n, 'data-sn-with') ?? '{}', scope), n));
        continue;
      }
      if (n.tagName.includes('-') && this.ctx.componentFile(n.tagName)) {
        if (n.attrs.some((a) => a.name !== 'data-sn-with')) throw BAIL;
        out.push(...this.component(n.tagName, evaluate(attrOf(n, 'data-sn-with') ?? '{}', scope), n));
        continue;
      }
      out.push(this.element(n, scope, file));
    }
    return out;
  }

  /** a `<template>` at `list[i]`: a branch (with the `data-sn-else` after it), a list or a text; returns the last index it took */
  template(list: readonly P5Node[], i: number, scope: Scope, file: string, out: P5Node[]): number {
    const t = list[i] as P5Template;
    const sn = t.attrs.filter((a) => a.name.startsWith('data-sn-'));
    if (sn.length !== 1 || t.attrs.length !== 1) throw BAIL;
    const [{ name, value }] = sn as [{ name: string; value: string }];
    if (name === 'data-sn-if') {
      let j = i + 1;
      while (j < list.length && !real(list[j]!)) j++;
      const next = list[j];
      const other = next && isElement(next) && next.tagName === 'template' && attrOf(next, 'data-sn-else') !== undefined ? next as P5Template : null;
      if (other && other.attrs.length !== 1) throw BAIL;
      const v = evaluate(value, scope);
      if (v) out.push(...this.nodes(t.content.childNodes, scope, file));
      else if (other) out.push(...this.nodes(other.content.childNodes, scope, file));
      return other ? j : i;
    }
    if (name === 'data-sn-for') {
      const m = /^\s*(?:\(\s*([A-Za-z_$][\w$]*)\s*,\s*([A-Za-z_$][\w$]*)\s*\)|([A-Za-z_$][\w$]*))\s+in\s+([\s\S]+)$/.exec(value);
      if (!m) throw BAIL;
      const items = evaluate(m[4]!, scope);
      if (!Array.isArray(items)) throw BAIL;
      const item = (m[1] ?? m[3])!, index = m[2];
      for (let k = 0; k < items.length; k++) {
        if (++this.count > this.ctx.limit) throw BAIL;
        const vars = new Map<string, unknown>([[item, items[k]]]);
        if (index) vars.set(index, k);
        out.push(...this.nodes(t.content.childNodes, scope.child(vars), file));
      }
      return i;
    }
    if (name === 'data-sn-text') {
      const w = this.ctx.paintValue(t, 'text', null, evaluate(value, scope));
      if (typeof w === 'symbol') throw BAIL;
      if (w[1]) out.push({ nodeName: '#text', value: w[1] as string, parentNode: null } as unknown as P5Node);
      return i;
    }
    // a `data-sn-else` without its `data-sn-if`, or anything else
    throw BAIL;
  }

  element(n: P5Element, scope: Scope, file: string): P5Element {
    for (const a of n.attrs) if (a.name.startsWith('data-sn-') && !ELEMENT_ATTRS.has(a.name)) throw BAIL;
    // an id in markup that may repeat is SN532 in the full compile: that compile says so
    if (attrOf(n, 'id') !== undefined) throw BAIL;
    const el = {
      nodeName: n.nodeName, tagName: n.tagName, namespaceURI: n.namespaceURI,
      attrs: n.attrs.filter((a) => !a.name.startsWith('data-sn-')).map((a) => ({ ...a })),
      childNodes: [] as P5Node[], parentNode: null, sourceCodeLocation: this.where,
    } as unknown as P5Element;
    if (n.tagName === 'template' || n.tagName === 'script' || n.tagName === 'style') throw BAIL;
    OWN_ATTRS.set(el, el.attrs.length);
    const attrs = attrOf(n, 'data-sn-attr');
    if (attrs !== undefined) {
      const v = evaluate(attrs, scope);
      if (!v || typeof v !== 'object' || Array.isArray(v)) throw BAIL;
      for (const [k, x] of Object.entries(v)) {
        const w = this.ctx.paintValue(el, 'attr', k, x);
        if (typeof w === 'symbol') throw BAIL;
        this.ctx.write(el, w[0], k, w[1]);
        if ((k === 'src' || k === 'srcset') && w[1] !== null) this.ctx.urlWritten(el);
      }
    }
    const classes = attrOf(n, 'data-sn-class');
    if (classes !== undefined) {
      const v = evaluate(classes, scope);
      if (!v || typeof v !== 'object' || Array.isArray(v)) throw BAIL;
      for (const [k, x] of Object.entries(v)) {
        const w = this.ctx.paintValue(el, 'class', k, x);
        if (typeof w === 'symbol') throw BAIL;
        this.ctx.write(el, w[0], k, w[1]);
      }
    }
    const text = attrOf(n, 'data-sn-text');
    if (text !== undefined) {
      if (n.childNodes.some(isElement)) throw BAIL;
      const w = this.ctx.paintValue(el, 'text', null, evaluate(text, scope));
      if (typeof w === 'symbol') throw BAIL;
      this.ctx.write(el, 'text', null, w[1]);
    } else el.childNodes = this.nodes(n.childNodes, scope, file) as P5Element["childNodes"];
    for (const c of el.childNodes) (c as { parentNode: P5Parent | null }).parentNode = el;
    return el;
  }
}

/**
 * The markup a component tag on the page renders, over `scope`'s constants (the page's `file:` resources, its entry,
 * its lets, the helpers), or null: compiled the usual way. `rendered`: how many instances and rows it took.
 */
export function renderStatic(host: P5Element, scope: Map<string, unknown>, ctx: StaticContext): { nodes: P5Node[]; rendered: number } | null {
  const r = new Renderer(ctx, host.sourceCodeLocation);
  try {
    if (host.attrs.some((a) => a.name !== 'data-sn-with')) return null;
    const def = ctx.componentFile(host.tagName);
    if (!def || def.internal) return null;
    const props = evaluate(attrOf(host, 'data-sn-with') ?? '{}', new Scope(new Map([...ctx.helpers, ...scope]), null));
    return { nodes: r.component(host.tagName, props, host), rendered: r.count };
  } catch (e) {
    if (e === BAIL) return null;
    throw e;
  }
}

/** an expression over `vars` (and the allowed globals): its value, or null when it reads anything else or throws */
export function evalConstant(expr: string, vars: Map<string, unknown>): { v: unknown } | null {
  try { return { v: evaluate(expr, new Scope(vars, null)) }; } catch (e) { if (e === BAIL) return null; throw e; }
}
