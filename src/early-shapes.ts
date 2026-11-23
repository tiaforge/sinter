// Early scripts that differ only in literals (docs/proposals/redesign-notes/early-script-shapes.md). On a blog every
// post's early source is one program with the post's slug in it; each was a nested build of its own (~13 ms). Here the
// sources are grouped by shape: the same tokens, the string and number literals that differ from page to page lifted
// out. A group is built once with a placeholder in each lifted place, of the same kind and length as the pages'
// values, and each page gets the built text with its own values written over the placeholders. The sharing checks
// itself: the first pages of a group are also built from their own source and must come out the same, else the
// whole group is built page by page (`src/vite.ts`, `generateBundle`).
import { tokenizer, tokTypes, type Token } from 'acorn';

/** a literal that may be lifted: where it is in the source, its value, and its kind (part of the group's key) */
export type Lit = { start: number; end: number; value: string | number; kind: string | null; why?: string };
/** a source cut at its literals: `parts[i]` before `lits[i]`, the last part after the last literal */
export type Cut = { lits: Lit[]; parts: string[]; skeleton: string };

/**
 * Strings a minifier knows by value (typeof's answers, directives, special keys and numbers): never lifted, so a
 * page that differs from another in one of these is a different shape.
 */
const SPECIAL = new Set(['undefined', 'object', 'function', 'string', 'number', 'boolean', 'symbol', 'bigint', 'use strict', '__proto__', 'constructor', 'prototype', 'length', 'NaN', 'Infinity', 'toString', 'valueOf', 'default']);
/** characters that need no escape in any quote a minifier picks ('', "", ``) and mean nothing in a template: no quote, backslash, `$`, `<`, control or non-ASCII */
const PLAIN = /^[A-Za-z0-9_\-.,:;/?&=+%#@!~*()|^[\]{} ]+$/;

/**
 * The kind of a literal value, or null when it is not lifted. Two pages share a build only where each lifted value
 * has the same kind, so the placeholder the group is built with is like every page's value: a string's class (an
 * identifier, a canonical integer, another starting with a digit, any other), its exact length; a number's digit count and
 * trailing zeros (how it is printed). What is left is the characters themselves, which the check compares.
 */
export function kindOf(v: string | number): string | null {
  if (typeof v === 'number') {
    if (!Number.isSafeInteger(v) || v < 10) return null;
    const s = String(v), zeros = s.length - s.replace(/0+$/, '').length;
    // 1000 prints as 1e3: only the integers a minifier prints as written
    return zeros >= 3 ? null : `N${s.length}.${zeros}`;
  }
  if (v.length < 2 || !PLAIN.test(v) || SPECIAL.has(v)) return null;
  const c = /^[A-Za-z_][A-Za-z0-9_]*$/.test(v) ? 'i' : /^[1-9][0-9]*$/.test(v) ? 'n' : /^[0-9]/.test(v) ? 'd' : 'p';
  return `S${c}${v.length}`;
}

/** the source cut at its string and number literals (not import or export specifiers), or null when it does not tokenize */
export function cut(src: string): Cut | null {
  const toks: Array<Token & { value: unknown }> = [];
  try {
    for (const t of tokenizer(src, { ecmaVersion: "latest", sourceType: "module" })) toks.push(t as Token & { value: unknown });
  } catch {
    return null;
  }
  const lits: Lit[] = [], parts: string[] = [];
  let at = 0, skeleton = '';
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i]!;
    const str = t.type === tokTypes.string, num = t.type === tokTypes.num;
    if (!str && !num) continue;
    const prev = toks[i - 1], prev2 = toks[i - 2];
    // a module specifier: `from '…'`, `import '…'`, `import('…')`
    if (str && prev && (prev.type === tokTypes._import || (prev.type === tokTypes.name && prev.value === 'from') || (prev.type === tokTypes.parenL && prev2?.type === tokTypes._import))) continue;
    const raw = src.slice(t.start, t.end);
    // only a literal written as its value (no escape, no `0x`, `1_000`, `.5`) is lifted
    const plain = str ? raw.slice(1, -1) === t.value : raw === String(t.value);
    const value = t.value as string | number;
    parts.push(src.slice(at, t.start));
    skeleton += src.slice(at, t.start) + (str ? `\0${raw[0]}` : '\0#');
    const kind = plain && passed(toks, i, str) ? kindOf(value) : null;
    lits.push({ start: t.start, end: t.end, value, kind, ...(kind ? {} : { why: !plain ? 'a literal written with an escape' : !passed(toks, i, str) ? 'a literal a minifier may compute with' : why(value) }) });
    at = t.end;
  }
  parts.push(src.slice(at));
  skeleton += src.slice(at);
  return { lits, parts, skeleton };
}

/**
 * Whether the literal at `toks[i]` is only passed along, behind any parentheses of its own: an argument, an element,
 * a property's value or key, a returned value, a branch or condition, an operand of `+` (a string's: concatenation
 * keeps its characters as they are). Not the object of a member (`"a".indexOf("-")`), an operand of a comparison or
 * of arithmetic, a `case`, a spread, or a binding's initializer (`const a = "x"`: a minifier may carry it into a
 * computation where `a` is used). So what a minifier can know of a lifted literal is what its placeholder shares
 * with every page's value: kind, length, truthiness, `typeof`.
 */
function passed(toks: Array<Token & { value: unknown }>, i: number, str: boolean): boolean {
  let a = 0, b = 0;
  while (toks[i - a - 1]?.type === tokTypes.parenL) a++;
  while (toks[i + b + 1]?.type === tokTypes.parenR) b++;
  // the outermost `(` is a call's (`f(("a"))`) after the end of an expression, a statement's after `if`, `switch`, …
  const out = toks[i - a - 1]?.type.label;
  if (a && out && ['if', 'switch', 'while', 'for', 'with'].includes(out)) return false;
  if (a && out && ['name', ')', ']', 'string', 'num', '`', 'regexp', 'true', 'false', 'null', 'this', 'super'].includes(out)) a--;
  const w = Math.min(a, b), before = toks[i - w - 1], after = toks[i + w + 1];
  const is = (t: (Token & { value: unknown }) | undefined, ok: string[]) => {
    if (!t || t.type === tokTypes.eof) return true;
    const l = t.type.label;
    if (l === '+/-') return str && t.value === '+';
    if (l === '!/~') return t.value === '!';
    return ok.includes(l);
  };
  return is(before, ['(', ',', '[', '{', ':', '?', '=>', 'return', '||', '&&', '??', 'typeof', 'void', '${'])
    && is(after, [')', ',', ']', '}', ';', ':', '?', '||', '&&', '??']);
}

/** the source with literal `i` written as `with.get(i)` where it has one (a string keeps its quote) */
export function paste(c: Cut, src: string, values: Map<number, string | number>): string {
  let out = c.parts[0]!;
  c.lits.forEach((l, i) => {
    const v = values.get(i);
    const raw = src.slice(l.start, l.end);
    out += (v === undefined ? raw : typeof v === 'number' ? String(v) : raw[0] + v + raw[0]) + c.parts[i + 1]!;
  });
  return out;
}

const ALNUM = 'abcdefghijklmnopqrstuvwxyz0123456789';
/**
 * Placeholders for a group: one per class of equal values, each of its kind and length (the first character fixes
 * the class: `Q…` an identifier, `9…` an integer, `9-…` digit-led, `-…` any other; integers keep their trailing zeros).
 * None occurs in `avoid` (the skeleton's text and every page's values), and no two are equal.
 */
export function placeholders(kinds: string[], avoid: string): string[] | null {
  const out: string[] = [];
  let n = 0;
  for (const k of kinds) {
    let p: string | null = null;
    for (let tries = 0; tries < 2000 && p === null; tries++, n++) {
      const cand = make(k, n);
      if (cand && !avoid.includes(cand) && !out.some((o) => o.includes(cand) || cand.includes(o))) p = cand;
    }
    if (p === null) return null;
    out.push(p);
  }
  return out;
}

/** the `n`th candidate of kind `k`, or null when that kind has no `n`th */
function make(k: string, n: number): string | null {
  const len = Number(k.slice(k[0] === 'N' ? 1 : 2).split('.')[0]);
  if (k[0] === 'N' || k[1] === 'n') {
    // counting down from 99…9: as many digits, the last one not 0, then the trailing zeros
    const zeros = k[0] === 'N' ? Number(k.split('.')[1]) : 0, body = len - zeros;
    const v = 10 ** body - 1 - n;
    if (v < 10 ** (body - 1)) return null;
    const s = String(v);
    return s.endsWith('0') && body > 0 ? '' : s + '0'.repeat(zeros);
  }
  const head = k[1] === 'i' ? 'Q' : k[1] === 'd' ? '9-' : '-';
  if (len < head.length + 1) return null;
  let tail = '', x = n;
  for (let i = 0; i < len - head.length; i++) { tail = ALNUM[x % 36] + tail; x = Math.floor(x / 36); }
  if (x > 0) return null;
  return head + tail;
}

/** `code` with every placeholder written over by its value (a string's characters as they are: they need no escape) */
export function fill(code: string, subs: Array<[string, string | number]>): string {
  for (const [p, v] of subs) code = code.split(p).join(String(v));
  return code;
}

/** what one nested build gives: the script, its modules (by id: rendered length) and the content keys its modules call */
export type Built = { code: string; map: null | unknown; modules: Record<string, { renderedLength: number; code?: string | null }>; keys: Set<string> };
/** a build's counts, summed over the process (`SN_EARLY_SHAPES_LOG=1` or the audit prints them at exit) */
export const shapeStats = { sources: 0, groups: 0, builds: 0, shared: 0, checked: 0, fallbacks: new Map<string, number>() };
const fallback = (why: string, n = 1) => shapeStats.fallbacks.set(why, (shapeStats.fallbacks.get(why) ?? 0) + n);
let exitHook = false;
const env = (k: string) => (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env[k];
/** sharing off: `SN_EARLY_SHAPES=0` */
export const shapesOn = () => env('SN_EARLY_SHAPES') !== '0';

/** the first pages of a group built from their own source as well, whose bytes must match the shared build's */
export const CHECKED = 2;

const same = (a: Built, b: Built) => a.code === b.code && JSON.stringify(Object.entries(a.modules).sort()) === JSON.stringify(Object.entries(b.modules).sort()) && [...a.keys].sort().join('\n') === [...b.keys].sort().join('\n');
const why = (v: string | number) => typeof v === 'number' ? (Number.isSafeInteger(v) ? (v < 10 ? 'a one-digit number' : 'a number printed with an exponent') : 'a number that is not an integer') : v.length < 2 ? 'a string shorter than 2' : SPECIAL.has(v) ? 'a string a minifier knows' : 'a string with characters that need escaping';

/**
 * Builds every source of `items` (`extra`: what else its build depends on, the runtime names), sharing one build
 * among those of one shape. Returns each item's build. `build` runs one nested build of a source.
 * `SN_EARLY_SHAPES_AUDIT=1`: every page whose script was written from a shared build is also built from its own
 * source, and a difference throws.
 */
export async function shareBuilds(items: Array<{ src: string; extra: string; what: string }>, build: (src: string, i: number, what: string) => Promise<Built>): Promise<Built[]> {
  const audit = env('SN_EARLY_SHAPES_AUDIT') === '1';
  if ((audit || env('SN_EARLY_SHAPES_LOG') === '1') && !exitHook) {
    exitHook = true;
    (globalThis as { process?: NodeJS.Process }).process?.on('exit', () => {
      const s = shapeStats;
      const f = [...s.fallbacks].sort((a, b) => b[1] - a[1]).map(([k, n]) => `${n} ${k}`).join('; ');
      console.error(`sinter early shapes: ${s.sources} distinct early sources, ${s.builds} nested builds (${s.groups} shared shapes for ${s.shared} sources, ${s.checked} checked against their own build${audit ? ', every one in the audit' : ''}); fell back: ${f || 'none'}`);
    });
  }
  const out: Array<Built | undefined> = new Array(items.length);
  const own = async (i: number) => { shapeStats.builds++; out[i] = await build(items[i]!.src, i, items[i]!.what); };
  shapeStats.sources += items.length;
  // by shape: the same tokens but the literals, and the same runtime names
  const cuts = items.map((x) => cut(x.src));
  const byShape = new Map<string, number[]>();
  items.forEach((x, i) => {
    const c = cuts[i];
    if (!c) { fallback('a source that does not tokenize'); return; }
    const k = x.extra + '\0\0' + c.skeleton;
    byShape.set(k, [...byShape.get(k) ?? [], i]);
  });
  const todo: number[] = items.map((_, i) => i).filter((i) => !cuts[i]);
  for (const [, members] of byShape) {
    if (members.length < CHECKED + 2) { todo.push(...members); continue; }
    const c0 = cuts[members[0]!]!;
    // the literals that differ between the pages; the others are the shape's own
    const vary = c0.lits.map((_, j) => j).filter((j) => members.some((m) => cuts[m]!.lits[j]!.value !== c0.lits[j]!.value));
    // by kind: each lifted value's kind, which of them are equal, which equal one of the shape's own literals
    const byKind = new Map<string, number[]>();
    for (const m of members) {
      const lits = cuts[m]!.lits, fixed = new Set(lits.filter((_, j) => !vary.includes(j)).map((l) => l.value));
      const bad = vary.find((j) => lits[j]!.kind === null);
      if (bad !== undefined) { fallback(`a literal not lifted: ${lits[bad]!.why}`); todo.push(m); continue; }
      const k = vary.map((j) => `${lits[j]!.kind}=${vary.findIndex((x) => lits[x]!.value === lits[j]!.value)}${fixed.has(lits[j]!.value) ? 'f' : ''}`).join(' ');
      byKind.set(k, [...byKind.get(k) ?? [], m]);
    }
    for (const [, ms] of byKind) {
      if (ms.length < CHECKED + 2) { fallback('a kind of literal with fewer than 4 pages', ms.length); todo.push(...ms); continue; }
      const first = cuts[ms[0]!]!;
      // one placeholder per class of equal values
      const cls = vary.filter((j) => vary.find((x) => first.lits[x]!.value === first.lits[j]!.value) === j);
      const avoid = [c0.skeleton, ...ms.flatMap((m) => cuts[m]!.lits.map((l) => String(l.value)))].join('\0');
      const phs = placeholders(cls.map((j) => first.lits[j]!.kind!), avoid);
      if (!phs) { fallback('no placeholder', ms.length); todo.push(...ms); continue; }
      const classOf = (lits: Lit[], j: number) => cls.findIndex((x) => lits[x]!.value === lits[j]!.value);
      const pasted = new Map(vary.map((j) => { const p = phs[classOf(first.lits, j)]!; return [j, typeof first.lits[j]!.value === 'number' ? Number(p) : p] as const; }));
      shapeStats.builds++;
      const shape = await build(paste(first, items[ms[0]!]!.src, pasted), ms[0]!, `${items[ms[0]!]!.what} and ${ms.length - 1} more of its shape`);
      if ([...shape.keys].some((k) => phs.some((p) => k.includes(p)))) { fallback('a content key from a lifted literal', ms.length); todo.push(...ms); continue; }
      const written = (m: number): Built => {
        const subs = cls.map((j, i) => [phs[i]!, cuts[m]!.lits[j]!.value] as [string, string | number]);
        // a module's rendered code (Rolldown's, before the minifier) carries the placeholder too
        const modules = Object.fromEntries(Object.entries(shape.modules).map(([id, x]) => [id, typeof x.code === "string" ? { ...x, code: fill(x.code, subs) } : x]));
        return { code: fill(shape.code, subs), map: null, modules, keys: new Set([...shape.keys]) };
      };
      let ok = true;
      for (let n = 0; n < ms.length && ok; n++) {
        const m = ms[n]!, w = written(m);
        if (n < CHECKED || audit) {
          shapeStats.builds++;
          const real = await build(items[m]!.src, m, items[m]!.what);
          out[m] = real;
          if (n < CHECKED) shapeStats.checked++;
          // (`SN_EARLY_SHAPES_AUDIT_LOG=<file>`: a line per page the audit checked, so a run can say how many)
          else if (env('SN_EARLY_SHAPES_AUDIT_LOG')) (await import('node:fs')).appendFileSync(env('SN_EARLY_SHAPES_AUDIT_LOG')!, `${items[m]!.what}\n`);
          if (!same(w, real)) {
            if (n >= CHECKED) throw new Error(`sinter: SN_EARLY_SHAPES_AUDIT: the early script of ${items[m]!.what}, written from its shape's build, differs from its own build:\n${w.code}\n${real.code}`);
            fallback('differs from its own build once written', ms.length - n - 1);
            todo.push(...ms.slice(n + 1));
            ok = false;
          }
        } else out[m] = w;
      }
      if (ok) { shapeStats.groups++; shapeStats.shared += ms.length; }
    }
  }
  for (const i of todo.sort((a, b) => a - b)) await own(i);
  return out as Built[];
}
