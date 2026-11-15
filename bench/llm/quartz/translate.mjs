// Quartz → Svelte translator. Pure functions, no dependencies.
//   translate(source, { filename })  one .qz component: block syntax, directives, runes in <script>
//   renameRunes(js)                  rune names in call position only ($cell( → $state( …)
//   renameDataExports(js)            route data modules: export function fetchData → load, handlers → actions
// Everything goes through a small JS lexer that knows strings, template literals, comments and regexes,
// so text inside them is never rewritten.

export const RUNES = { $cell: '$state', $from: '$derived', $inputs: '$props', $watch: '$effect', $twoway: '$bindable', $peek: '$inspect' };
export const DIRECTIVES = { sync: 'bind', toggle: 'class', with: 'use', anim: 'transition', enter: 'in', leave: 'out', css: 'style' };
export const DATA_EXPORTS = { fetchData: 'load', handlers: 'actions' };

export class QuartzError extends Error {
  constructor(message, src, pos, filename) {
    const { line, column } = lineCol(src, pos);
    super(`${filename ? filename + ':' : ''}${line}:${column} ${message}`);
    Object.assign(this, { line, column, filename, pos });
  }
}

function lineCol(src, pos) {
  const before = src.slice(0, pos).split('\n');
  return { line: before.length, column: before[before.length - 1].length + 1 };
}

// ---------------------------------------------------------------- JS lexer

const ID_START = /[A-Za-z_$\u0080-￿]/, ID_PART = /[A-Za-z0-9_$\u0080-￿]/;
const REGEX_AFTER_WORD = new Set(['return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void', 'throw', 'case', 'do', 'else', 'yield', 'await']);

function regexAllowed(prev) {
  if (!prev) return true;
  if (prev.type === 'ident') return REGEX_AFTER_WORD.has(prev.value);
  if (prev.type === 'punct') return !(prev.value === ')' || prev.value === ']' || prev.value === '}');
  return false; // after a number, string, template or regex
}

/** One token starting at i. `prev` is the previous significant token (for the regex / divide decision). */
function lex(src, i, prev) {
  const c = src[i], start = i;
  if (/\s/.test(c)) { while (i < src.length && /\s/.test(src[i])) i++; return { type: 'ws', start, end: i }; }
  if (c === '/' && src[i + 1] === '/') { while (i < src.length && src[i] !== '\n') i++; return { type: 'comment', start, end: i }; }
  if (c === '/' && src[i + 1] === '*') {
    const e = src.indexOf('*/', i + 2);
    if (e < 0) throw new QuartzError('unterminated comment', src, start);
    return { type: 'comment', start, end: e + 2 };
  }
  if (c === '"' || c === "'") {
    i++;
    while (i < src.length && src[i] !== c) { if (src[i] === '\\') i++; else if (src[i] === '\n') break; i++; }
    if (src[i] !== c) throw new QuartzError('unterminated string', src, start);
    return { type: 'string', start, end: i + 1 };
  }
  if (c === '`') return { type: 'template', start, end: skipTemplate(src, i) };
  if (c === '/' && regexAllowed(prev)) {
    i++; let inClass = false;
    while (i < src.length && (inClass || src[i] !== '/')) {
      if (src[i] === '\n') throw new QuartzError('unterminated regex', src, start);
      if (src[i] === '\\') i++; else if (src[i] === '[') inClass = true; else if (src[i] === ']') inClass = false;
      i++;
    }
    i++; while (i < src.length && ID_PART.test(src[i])) i++;
    return { type: 'regex', start, end: i };
  }
  if (ID_START.test(c)) { while (i < src.length && ID_PART.test(src[i])) i++; return { type: 'ident', value: src.slice(start, i), start, end: i }; }
  if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(src[i + 1]))) { while (i < src.length && /[0-9A-Za-z_.]/.test(src[i])) i++; return { type: 'num', start, end: i }; }
  return { type: 'punct', value: c, start, end: i + 1 };
}

/** i at the opening backtick; returns the index after the closing one. */
function skipTemplate(src, i) {
  const start = i++;
  while (i < src.length) {
    if (src[i] === '\\') { i += 2; continue; }
    if (src[i] === '`') return i + 1;
    if (src[i] === '$' && src[i + 1] === '{') { i = scanExpr(src, i + 2, '}', start) + 1; continue; }
    i++;
  }
  throw new QuartzError('unterminated template literal', src, start);
}

/** The [start, end) ranges of the ${…} holes of the template literal at i (one level). */
function templateHoles(src, i) {
  const holes = []; i++;
  while (src[i] !== '`') {
    if (src[i] === '\\') { i += 2; continue; }
    if (src[i] === '$' && src[i + 1] === '{') { const e = scanExpr(src, i + 2, '}', i); holes.push([i + 2, e]); i = e + 1; continue; }
    i++;
  }
  return holes;
}

/** Scans JS from i to the closer ('}' or ']]') at bracket depth 0; returns the closer's index. */
function scanExpr(src, i, closer, openedAt = i) {
  const stack = []; let prev = null;
  while (i < src.length) {
    const t = lex(src, i, prev);
    if (t.type === 'punct') {
      const v = t.value;
      if (v === '(' || v === '[' || v === '{') stack.push(v);
      else if (v === ')' || v === ']' || v === '}') {
        if (!stack.length) {
          if (closer === '}' && v === '}') return t.start;
          if (closer === ']]' && v === ']' && src[t.start + 1] === ']') return t.start;
          throw new QuartzError(`unexpected "${v}"`, src, t.start);
        }
        const open = stack.pop();
        if ({ ')': '(', ']': '[', '}': '{' }[v] !== open) throw new QuartzError(`"${v}" does not match "${open}"`, src, t.start);
      }
    }
    if (t.type !== 'ws' && t.type !== 'comment') prev = t;
    i = t.end;
  }
  throw new QuartzError(closer === '}' ? 'unclosed "{"' : 'unclosed "[["', src, openedAt);
}

/** All tokens of a JS source, with `prev` tracking. */
function tokens(src) {
  const out = []; let i = 0, prev = null;
  while (i < src.length) {
    const t = lex(src, i, prev);
    out.push(t);
    if (t.type !== 'ws' && t.type !== 'comment') prev = t;
    i = t.end;
  }
  return out;
}

function applyEdits(src, edits) {
  let out = '', last = 0;
  for (const e of edits.sort((a, b) => a.start - b.start)) { out += src.slice(last, e.start) + e.text; last = e.end; }
  return out + src.slice(last);
}

// ---------------------------------------------------------------- script passes

/** Renames runes used as calls: `$cell(`, `$cell<T>(`, `$from.by(`; not `x.$cell(`, not in strings or comments. */
export function renameRunes(js, map = RUNES) {
  const sig = tokens(js).filter((t) => t.type !== 'ws' && t.type !== 'comment');
  const edits = [];
  for (const t of sig) if (t.type === 'template') {
    for (const [a, b] of templateHoles(js, t.start)) edits.push({ start: a, end: b, text: renameRunes(js.slice(a, b), map) });
  }
  sig.forEach((t, k) => {
    if (t.type !== 'ident' || !Object.hasOwn(map, t.value)) return;
    const before = sig[k - 1], after = sig[k + 1];
    if (before && before.type === 'punct' && before.value === '.') return; // member access: obj.$cell()
    if (!after || after.type !== 'punct' || !['(', '.', '<'].includes(after.value)) return;
    edits.push({ start: t.start, end: t.end, text: map[t.value] });
  });
  return applyEdits(js, edits);
}

/** In a route data module: `export [async] function fetchData` / `export const fetchData` → load (and handlers → actions). */
export function renameDataExports(js, map = DATA_EXPORTS) {
  const sig = tokens(js).filter((t) => t.type !== 'ws' && t.type !== 'comment');
  const edits = [];
  for (let k = 0; k < sig.length; k++) {
    if (sig[k].value !== 'export' || sig[k].type !== 'ident') continue;
    let j = k + 1;
    if (sig[j]?.value === 'async') j++;
    if (sig[j]?.value === 'function') { j++; if (sig[j]?.value === '*') j++; }
    else if (['const', 'let', 'var'].includes(sig[j]?.value)) j++;
    else continue;
    const name = sig[j];
    if (name?.type === 'ident' && Object.hasOwn(map, name.value)) edits.push({ start: name.start, end: name.end, text: map[name.value] });
  }
  return applyEdits(js, edits);
}

// ---------------------------------------------------------------- markup

const BLOCK_CLOSE = { if: '{/if}', for: '{/each}', wait: '{/await}', part: '{/snippet}' };

/** Translates one .qz component to Svelte. */
export function translate(src, { filename } = {}) {
  let out = '', i = 0;
  const stack = []; // { kind, pos, hasElse }
  const fail = (msg, pos) => { throw new QuartzError(msg, src, pos, filename); };

  try {
    while (i < src.length) {
      if (src.startsWith('<!--', i)) {
        const e = src.indexOf('-->', i + 4);
        if (e < 0) fail('unclosed comment', i);
        out += src.slice(i, e + 3); i = e + 3; continue;
      }
      const raw = /^<(script|style)(?=[\s>])/i.exec(src.slice(i, i + 8));
      if (raw) {
        const name = raw[1].toLowerCase();
        const openEnd = tagEnd(src, i);
        const close = src.toLowerCase().indexOf(`</${name}`, openEnd);
        if (close < 0) fail(`unclosed <${name}>`, i);
        const body = src.slice(openEnd, close);
        out += translateTag(src.slice(i, openEnd)) + (name === 'script' ? renameRunes(body) : body);
        i = close; continue;
      }
      if (src[i] === '<' && /[A-Za-z]/.test(src[i + 1] ?? '')) {
        const e = tagEnd(src, i);
        out += translateTag(src.slice(i, e)); i = e; continue;
      }
      if (src[i] === '{') {
        const e = scanExpr(src, i + 1, '}', i);
        out += src.slice(i, e + 1); i = e + 1; continue;
      }
      if (src.startsWith('[[', i)) {
        const e = scanExpr(src, i + 2, ']]', i);
        out += block(src.slice(i + 2, e), i); i = e + 2; continue;
      }
      out += src[i++];
    }
  } catch (err) {
    if (err instanceof QuartzError && !err.filename && filename) throw new QuartzError(err.message.replace(/^\d+:\d+ /, ''), src, err.pos, filename);
    throw err;
  }
  if (stack.length) { const top = stack[stack.length - 1]; fail(`[[${top.kind}]] is never closed with [[end]]`, top.pos); }
  return out;

  function block(content, pos) {
    const m = /^\s*([a-z]+)\b\s*([\s\S]*?)\s*$/.exec(content);
    if (!m) fail(`expected a block keyword after "[["`, pos);
    const [, kw, rest] = m, top = stack[stack.length - 1];
    const need = (kinds, what) => { if (!top || !kinds.includes(top.kind)) fail(`[[${what}]] outside ${kinds.map((k) => `[[${k}]]`).join(' or ')}`, pos); };
    const arg = (what) => { if (!rest) fail(`[[${what}]] needs an expression`, pos); return rest; };
    switch (kw) {
      case 'if': stack.push({ kind: 'if', pos }); return `{#if ${arg('if')}}`;
      case 'elif': need(['if'], 'elif'); if (top.hasElse) fail('[[elif]] after [[else]]', pos); return `{:else if ${arg('elif')}}`;
      case 'else':
        need(['if', 'for'], 'else'); if (top.hasElse) fail('a second [[else]]', pos);
        if (rest.startsWith('if ') && top.kind === 'if') return `{:else if ${rest.slice(3)}}`;
        if (rest) fail('[[else]] takes no expression (use [[elif …]])', pos);
        top.hasElse = true; return '{:else}';
      case 'for': stack.push({ kind: 'for', pos }); return forBlock(arg('for'), pos);
      case 'wait': stack.push({ kind: 'wait', pos }); return `{#await ${arg('wait')}}`;
      case 'done': need(['wait'], 'done'); return rest ? `{:then ${rest}}` : '{:then}';
      case 'failed': need(['wait'], 'failed'); return rest ? `{:catch ${rest}}` : '{:catch}';
      case 'part': stack.push({ kind: 'part', pos }); return `{#snippet ${arg('part')}}`;
      case 'end': if (!top) fail('[[end]] without an open block', pos); stack.pop(); return BLOCK_CLOSE[top.kind];
      case 'raw': return `{@html ${arg('raw')}}`;
      case 'let': return `{@const ${arg('let')}}`;
      case 'show': return `{@render ${arg('show')}}`;
      default: fail(`unknown block [[${kw}]]`, pos);
    }
  }

  // `item, i in items by item.id` → `{#each items as item, i (item.id)}`
  function forBlock(s, pos) {
    const top = topLevel(s), inTok = top.find((t) => t.type === 'ident' && t.value === 'in');
    if (!inTok) return `{#each ${s}}`;
    const pattern = s.slice(0, inTok.start).trim();
    const afterIn = top.filter((t) => t.start > inTok.start);
    const byTok = afterIn.find((t, k) => t.type === 'ident' && t.value === 'by' && !(afterIn[k - 1]?.type === 'punct' && afterIn[k - 1].value === '.'));
    const expr = s.slice(inTok.end, byTok ? byTok.start : s.length).trim();
    const key = byTok ? s.slice(byTok.end).trim() : '';
    if (!pattern || !expr || (byTok && !key)) fail('expected [[for item, index in list by key]]', pos);
    return `{#each ${expr} as ${pattern}${key ? ` (${key})` : ''}}`;
  }
}

/** Significant tokens of `s` that sit at bracket depth 0. */
function topLevel(s) {
  let depth = 0; const out = [];
  for (const t of tokens(s)) {
    if (t.type === 'ws' || t.type === 'comment') continue;
    if (t.type === 'punct' && '([{'.includes(t.value)) depth++;
    else if (t.type === 'punct' && ')]}'.includes(t.value)) depth--;
    else if (depth === 0) out.push(t);
  }
  return out;
}

/** i at '<'; returns the index after the tag's closing '>', skipping quoted values and {expressions}. */
function tagEnd(src, i) {
  const start = i; i++;
  while (i < src.length) {
    const c = src[i];
    if (c === '>') return i + 1;
    if (c === '"' || c === "'") i = quotedEnd(src, i);
    else if (c === '{') i = scanExpr(src, i + 1, '}', i) + 1;
    else i++;
  }
  throw new QuartzError('unclosed tag', src, start);
}

function quotedEnd(src, i) {
  const q = src[i], start = i++;
  while (i < src.length && src[i] !== q) i = src[i] === '{' ? scanExpr(src, i + 1, '}', i) + 1 : i + 1;
  if (i >= src.length) throw new QuartzError('unclosed attribute value', src, start);
  return i + 1;
}

/** Rewrites directive prefixes in one tag's text (sync:value → bind:value); values are left alone. */
function translateTag(tag) {
  let out = '', i = 0;
  const name = /^<\/?[^\s/>]+/.exec(tag)[0];
  out += name; i = name.length;
  while (i < tag.length) {
    const c = tag[i];
    if (c === '"' || c === "'") { const e = quotedEnd(tag, i); out += tag.slice(i, e); i = e; continue; }
    if (c === '{') { const e = scanExpr(tag, i + 1, '}', i) + 1; out += tag.slice(i, e); i = e; continue; }
    if (/[\s=/>]/.test(c)) { out += c; i++; continue; }
    const m = /^[^\s=/>"'{]+/.exec(tag.slice(i))[0];
    const d = /^([a-z]+):/.exec(m);
    out += d && Object.hasOwn(DIRECTIVES, d[1]) && tag[i - 1] !== '=' ? DIRECTIVES[d[1]] + m.slice(d[1].length) : m;
    i += m.length;
  }
  return out;
}
