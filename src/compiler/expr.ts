// Expression analysis: parses one attribute value, resolves every identifier
// against the lexical scope, enforces the sandbox, extracts dependency paths
// (value expressions) and written paths (handlers), and emits a function.
import * as acorn from 'acorn';
import { type Code, didYouMean } from './diagnostics.js';

type Node = acorn.AnyNode & { start: number; end: number };

export type Mode = 'value' | 'handler' | 'optimistic';

export interface LoopEntry {
  name: string;
  kind: 'item' | 'index';
  /** item over a state path: its path with the instance index (`$s1.draft.emails.{$i3}`) */
  alias: string[] | null;
  /** item rooted at a resource */
  resource: string | null;
  /** index: the item's alias, so `list[i]` over the same list becomes the row's own element */
  of?: string[] | null;
}

export interface StateEntry { sid: number; names: Set<string> }

/** A `data-sn-let` name: a value expression inlined wherever the name is read. */
export interface LetEntry {
  name: string;
  /** the compiled expression (without the `($) =>` wrapper) */
  code: string;
  deps: string[];
  usesEl: boolean;
  usesIndex: boolean;
  resource: string | null;
}

export interface ResourceInfo {
  name: string; key: string[] | null; paginate: string | null; used: boolean;
  /** keyset with `offset-param`: `page(name, n)` and `$meta.<name>.page` are available */
  jumps?: boolean;
}

export interface Scope {
  loops: LoopEntry[];
  states: StateEntry[];
  /** `data-sn-let` names, outer to inner */
  lets?: LetEntry[];
}

export interface PageInfo {
  resources: Map<string, ResourceInfo>;
  helpers: Set<string>;
  /** action functions and namespaces: only `data-sn-call` and `<sn-resource call>` may name them */
  actions?: Set<string>;
  namespaces: Map<string, Set<string>>;
  /** imports used by emitted code */
  usedHelpers: Set<string>;
  usedNs: Map<string, Set<string>>;
  usesNow: boolean;
  /** `:name` segments of the page's `data-sn-path` patterns */
  pathParams: Set<string>;
  /** literal `id`s of the page's `<dialog>` elements, for `showModal()` and `close()` */
  dialogs: Set<string>;
}

export interface ExprOptions {
  mode: Mode;
  /** magic names allowed here besides the everywhere ones */
  magic?: string[];
  /** free identifiers resolve to fields of `$.$p` (sn-event, cursor) */
  payload?: boolean;
  /** with `payload`: state names in scope resolve to the state first (`<sn-event>`) */
  payloadState?: boolean;
  /** a handler with no element (`<sn-event>`, `<sn-resource>` `then`): `close()` names its dialog, no `reset()` or `emit()` */
  noElement?: string;
  /** parse as `{...}` object literal; returns its entries */
  object?: 'literal-keys' | 'any-keys' | 'state';
  report: (code: Code, message: string, offset: number, hint?: string) => void;
}

export interface ObjectEntry { key: string; code: string; deps: string[]; offset: number; literal: boolean }

export interface ExprResult {
  ok: boolean;
  code: string;
  /** `code` without its `($) =>` wrapper (value expressions) */
  inner: string;
  deps: string[];
  writes: string[];
  usesEl: boolean;
  /** reads a loop index variable */
  usesIndex: boolean;
  entries?: ObjectEntry[];
  /** the expression is a plain member path */
  path: string[] | null;
  /** resource the expression is rooted at */
  resource: string | null;
  ast: Node | null;
  /** names resolved to payload fields (`payload` mode) */
  payloadNames?: string[];
  /** state names read where the payload is the scope (they shadow payload fields of the same name) */
  payloadStates?: string[];
}

const EVERYWHERE_MAGIC = ['$el', '$url', '$now', '$locale', '$meta'];
export const ALL_MAGIC = ['$event', '$el', '$url', '$now', '$locale', '$result', '$error', '$meta'];
export const STORE_FNS = ['refresh', 'upsert', 'patch', 'remove', 'page', 'showModal', 'close', 'reset', 'emit'];
export const BUILTIN_HELPERS = ['date', 'time', 'datetime', 'relative', 'number', 'bytes'];
export const META_FIELDS = ['loading', 'error', 'loadedAt', 'pending', 'total', 'page', 'pages', 'from', 'to', 'hasPrev', 'hasNext'];
const PAGE_FIELDS = ['page', 'pages', 'from', 'to', 'hasPrev', 'hasNext'];

export const GLOBALS = new Set([
  'undefined', 'NaN', 'Infinity', 'isFinite', 'isNaN', 'parseFloat', 'parseInt',
  'decodeURI', 'decodeURIComponent', 'encodeURI', 'encodeURIComponent',
  'Array', 'ArrayBuffer', 'BigInt', 'BigInt64Array', 'BigUint64Array', 'Boolean', 'DataView', 'Date',
  'Error', 'EvalError', 'AggregateError', 'Float32Array', 'Float64Array', 'Int8Array', 'Int16Array',
  'Int32Array', 'Intl', 'Iterator', 'JSON', 'Map', 'Math', 'Number', 'Object', 'Promise', 'RangeError',
  'ReferenceError', 'RegExp', 'Set', 'String', 'Symbol', 'SyntaxError', 'TypeError', 'URIError',
  'Uint8Array', 'Uint8ClampedArray', 'Uint16Array', 'Uint32Array', 'WeakMap', 'WeakSet',
  'URL', 'URLSearchParams', 'structuredClone',
]);
const META_TOOLS = new Set(['eval', 'Function', 'Proxy', 'Reflect', 'globalThis', 'WeakRef', 'FinalizationRegistry', 'Atomics']);
const BROWSER = new Set([
  'window', 'document', 'fetch', 'localStorage', 'sessionStorage', 'navigator', 'location', 'history',
  'setTimeout', 'setInterval', 'clearTimeout', 'clearInterval', 'requestAnimationFrame', 'queueMicrotask',
  'XMLHttpRequest', 'WebSocket', 'EventSource', 'alert', 'confirm', 'prompt', 'console', 'self', 'top',
  'parent', 'frames', 'opener', 'indexedDB', 'crypto', 'performance', 'SharedArrayBuffer', 'importScripts',
  'customElements', 'Worker', 'Notification', 'caches',
]);
const FORBIDDEN_KEYS = new Set(['constructor', '__proto__', 'prototype']);

const READ_ONLY = new Set([
  'includes', 'indexOf', 'lastIndexOf', 'map', 'filter', 'slice', 'find', 'findIndex', 'findLast',
  'findLastIndex', 'some', 'every', 'reduce', 'reduceRight', 'join', 'concat', 'flat', 'flatMap', 'at',
  'entries', 'keys', 'values', 'forEach', 'toString', 'toLocaleString', 'toSorted', 'toReversed',
  'toSpliced', 'with', 'has', 'get', 'startsWith', 'endsWith', 'trim', 'trimStart', 'trimEnd',
  'toLowerCase', 'toUpperCase', 'toLocaleLowerCase', 'toLocaleUpperCase', 'split', 'substring',
  'charAt', 'charCodeAt', 'codePointAt', 'padStart', 'padEnd', 'repeat', 'replace', 'replaceAll',
  'match', 'matchAll', 'search', 'localeCompare', 'normalize', 'toFixed', 'toPrecision', 'valueOf',
  'getTime', 'toISOString', 'toJSON', 'getFullYear', 'getMonth', 'getDate', 'getDay', 'getHours',
  'getMinutes', 'getSeconds', 'test', 'exec',
]);
const MUTATORS = new Set(['push', 'pop', 'splice', 'sort', 'reverse', 'shift', 'unshift', 'fill', 'copyWithin', 'add', 'delete', 'clear', 'set']);
/** `Object.<static>(target, …)` calls that change their first argument */
const OBJECT_MUTATORS = new Set(['assign', 'defineProperty', 'defineProperties', 'setPrototypeOf']);
/** callbacks of these methods receive elements of the receiver as first parameter */
const ELEMENT_CALLBACKS = new Set(['forEach', 'map', 'filter', 'find', 'findIndex', 'findLast', 'findLastIndex', 'some', 'every', 'flatMap', 'toSorted', 'sort']);

type Resolved =
  | { kind: 'local'; info: LocalInfo }
  | { kind: 'loop'; entry: LoopEntry }
  | { kind: 'let'; entry: LetEntry }
  | { kind: 'state'; sid: number }
  | { kind: 'resource' }
  | { kind: 'magic' }
  | { kind: 'store' }
  | { kind: 'helper' }
  | { kind: 'ns' }
  | { kind: 'global' }
  | { kind: 'payload' };

interface LocalInfo { alias: string[] | null; resource: string | null }
type Locals = Map<string, LocalInfo>;

interface Edit { start: number; end: number; text: string }

/** The root and static segments of a member chain. */
interface ChainPath {
  root: string;
  res: Resolved;
  /** dependency/write path, or null if not trackable (row-local, local, global) */
  segs: string[] | null;
  /** resource the value is rooted at */
  resource: string | null;
  /** the receiver chain is the callee of a call */
}

export function analyze(src: string, scope: Scope, page: PageInfo, opts: ExprOptions): ExprResult {
  const edits: Edit[] = [];
  const deps = new Set<string>();
  const writes = new Set<string>();
  let usesEl = false;
  let usesIndex = false;
  let ok = true;
  const payloadNames = new Set<string>();
  const payloadStates = new Set<string>();
  const mode = opts.mode;
  const magicAllowed = new Set([...EVERYWHERE_MAGIC, ...(opts.magic ?? [])]);

  const report = (code: Code, message: string, offset: number, hint?: string) => {
    if (code < 'SN500') ok = false;
    opts.report(code, message, offset, hint);
  };

  // ---- parsing
  let ast: Node | null = null;
  let body: Node[] = [];
  const parseOpts: acorn.Options = { ecmaVersion: 'latest', sourceType: 'module', allowAwaitOutsideFunction: false };
  try {
    if (mode === 'value' || opts.object) {
      ast = acorn.parseExpressionAt(src, 0, parseOpts) as Node;
      // without preserveParens, `(a ? b : c)` ends inside its parentheses; find the real end
      const end = (acorn.parseExpressionAt(src, 0, { ...parseOpts, preserveParens: true }) as Node).end;
      const rest = src.slice(end).trim();
      if (rest) {
        const at = src.indexOf(rest, end);
        report('SN401', `unexpected \`${rest.slice(0, 20)}\` after the expression`, at);
        return fail();
      }
      body = [ast];
    } else {
      const prog = acorn.parse(src, parseOpts) as acorn.Program;
      ast = prog as Node;
      for (const st of prog.body) {
        if (st.type === 'EmptyStatement') continue;
        if (st.type !== 'ExpressionStatement') {
          const what = st.type.endsWith('Declaration') ? 'declarations' : st.type.replace(/Statement$/, '').toLowerCase() + ' statements';
          report('SN203', `handlers cannot contain ${what}; use expressions separated by \`;\``, st.start);
          continue;
        }
        body.push(st.expression as Node);
      }
    }
  } catch (e) {
    const err = e as SyntaxError & { pos?: number };
    report('SN401', err.message.replace(/ \(\d+:\d+\)$/, ''), err.pos ?? 0);
    return fail();
  }

  function fail(): ExprResult {
    return { ok: false, code: '() => undefined', inner: 'undefined', deps: [], writes: [], usesEl: false, usesIndex: false, path: null, resource: null, ast: null };
  }

  // ---- resolution
  function resolve(name: string, locals: Locals, offset: number, member?: string): Resolved | null {
    const local = locals.get(name);
    if (local) return { kind: 'local', info: local };
    if (name.startsWith('$')) {
      if (ALL_MAGIC.includes(name)) {
        if (!magicAllowed.has(name)) {
          report('SN201', `\`${name}\` is not available here`, offset);
          return null;
        }
        if (name === '$el') usesEl = true;
        if (name === '$now') page.usesNow = true;
        return { kind: 'magic' };
      }
      report('SN201', `\`${name}\` is not defined.${didYouMean(name, ALL_MAGIC)}`, offset);
      return null;
    }
    if (opts.payload && opts.payloadState) {
      for (let i = scope.states.length - 1; i >= 0; i--) {
        if (scope.states[i]!.names.has(name)) { payloadStates.add(name); return { kind: 'state', sid: scope.states[i]!.sid }; }
      }
    }
    if (!opts.payload) {
      // a let cannot share a name with a loop or state in its scope (SN209), so lets resolve first
      const lets = scope.lets ?? [];
      for (let i = lets.length - 1; i >= 0; i--) {
        if (lets[i]!.name === name) return { kind: 'let', entry: lets[i]! };
      }
      for (let i = scope.loops.length - 1; i >= 0; i--) {
        if (scope.loops[i]!.name === name) return { kind: 'loop', entry: scope.loops[i]! };
      }
      for (let i = scope.states.length - 1; i >= 0; i--) {
        if (scope.states[i]!.names.has(name)) return { kind: 'state', sid: scope.states[i]!.sid };
      }
      const r = page.resources.get(name);
      if (r) { r.used = true; return { kind: 'resource' }; }
    }
    // an <sn-event> `then` calls store functions; its value expressions do not
    if (STORE_FNS.includes(name) && (!opts.payload || mode === 'handler')) return { kind: 'store' };
    if (page.namespaces.has(name)) return { kind: 'ns' };
    if (page.helpers.has(name) || BUILTIN_HELPERS.includes(name)) return { kind: 'helper' };
    if (GLOBALS.has(name)) return { kind: 'global' };
    if (META_TOOLS.has(name)) {
      report('SN202', `\`${name}\` is not allowed in expressions`, offset);
      return null;
    }
    if (opts.payload) { payloadNames.add(name); return { kind: 'payload' }; }
    if (page.actions?.has(name)) {
      report('SN203', `\`${name}\` is an action: actions run through \`data-sn-call\` or \`<sn-resource call>\`, not inside expressions`, offset);
      return null;
    }
    if (BROWSER.has(name)) {
      report('SN202', `\`${name}\` is a browser API; expressions may use JavaScript, not the browser. Use an island`, offset);
      return null;
    }
    if (opts.payload) { payloadNames.add(name); return { kind: 'payload' }; }
    const candidates = [
      ...(scope.lets ?? []).map((l) => l.name), ...scope.loops.map((l) => l.name), ...scope.states.flatMap((s) => [...s.names]),
      ...page.resources.keys(), ...page.helpers, ...page.namespaces.keys(), ...STORE_FNS, ...BUILTIN_HELPERS,
    ];
    report('SN201', `\`${name}\` is not defined here.${didYouMean(name, candidates)}`, offset);
    void member;
    return null;
  }

  function emitName(name: string, res: Resolved, sid?: number): string {
    switch (res.kind) {
      case 'local': case 'global': case 'helper': return name;
      case 'loop': return `$.${name}`;
      case 'let': return `(${res.entry.code})`;
      case 'state': return `$.$s${sid}.${name}`;
      case 'resource': return `$.$r.${name}`;
      case 'magic': return `$.${name}`;
      case 'store': return `$.$f.${name}`;
      case 'payload': return `$.$p.${name}`;
      case 'ns': return name;
    }
  }

  function basePath(name: string, res: Resolved): { segs: string[] | null; resource: string | null } {
    switch (res.kind) {
      case 'state': return { segs: [`$s${res.sid}`, name], resource: null };
      case 'resource': return { segs: ['$r', name], resource: name };
      case 'magic':
        return name === '$el' || name === '$event' || name === '$result' || name === '$error'
          ? { segs: null, resource: null } : { segs: [name], resource: null };
      case 'loop':
        return { segs: res.entry.alias ? [...res.entry.alias] : null, resource: res.entry.resource };
      case 'local':
        return { segs: res.info.alias ? [...res.info.alias] : null, resource: res.info.resource };
      case 'let': return { segs: null, resource: res.entry.resource };
      default: return { segs: null, resource: null };
    }
  }

  /** Static path of an Identifier/MemberExpression chain; null if the leftmost object is not an identifier. */
  function chainPath(n: Node, locals: Locals): ChainPath | null {
    const props: Array<string> = [];
    let cur: Node = n;
    while (cur.type === 'MemberExpression') {
      const m = cur as acorn.MemberExpression & Node;
      if (!m.computed && m.property.type === 'Identifier') props.unshift(m.property.name);
      else if (m.computed && m.property.type === 'Literal') props.unshift(String((m.property as acorn.Literal).value));
      else if (m.computed && m.property.type === 'Identifier') {
        const pn = m.property.name;
        const loop = !locals.has(pn) && !opts.payload ? [...scope.loops].reverse().find((l) => l.name === pn) : undefined;
        props.unshift(loop && loop.kind === 'index' ? `{${pn}}` : '*');
      } else props.unshift('*');
      cur = m.object as Node;
    }
    if (cur.type === 'ChainExpression') return chainPath((cur as acorn.ChainExpression).expression as Node, locals);
    if (cur.type !== 'Identifier') return null;
    const name = (cur as acorn.Identifier).name;
    const res = resolveQuiet(name, locals);
    if (!res) return null;
    const base = basePath(name, res);
    const segs = base.segs ? [...base.segs, ...props] : null;
    // `list[i]` where `i` indexes that same list is the row's own element: use its row placeholder,
    // which the runtime may skip on structure changes (reconcile handles index moves)
    segs?.forEach((seg, k) => {
      const loop = seg[0] == '{' ? [...scope.loops].reverse().find((l) => l.kind == 'index' && `{${l.name}}` == seg) : undefined;
      if (loop?.of && loop.of.length == k + 1 && loop.of.slice(0, k).join('.') == segs.slice(0, k).join('.')) segs[k] = loop.of[k]!;
    });
    return { root: name, res, segs, resource: base.resource };
  }

  /** Resolution without diagnostics, for chains already resolved by the walker. */
  function resolveQuiet(name: string, locals: Locals): Resolved | null {
    const saved = opts.report;
    const savedOk = ok;
    const savedEl = usesEl;
    opts.report = () => {};
    try { return resolve(name, locals, 0); } finally { opts.report = saved; ok = savedOk; usesEl = savedEl || usesEl; }
  }

  function addDep(segs: string[] | null) {
    if (!segs) return;
    // `$meta.<name>.<field>`: validate resource and field
    if (segs[0] === '$meta') {
      if (segs.length < 2 || segs[1] === '*') { deps.add('$meta'); return; }
      deps.add(segs.slice(0, 3).join('.'));
      return;
    }
    deps.add(segs.join('.'));
  }

  function checkMeta(n: acorn.MemberExpression & Node, locals: Locals) {
    const cp = chainPath(n, locals);
    if (!cp || cp.root !== '$meta' || cp.res.kind !== 'magic' || !cp.segs) return;
    const [, rname, field] = cp.segs;
    if (rname && rname !== '*') {
      const r = page.resources.get(rname);
      if (!r) {
        report('SN301', `resource \`${rname}\` is not declared on this page.${didYouMean(rname, page.resources.keys())}`, n.start);
        return;
      }
      r.used = true;
      if (field && field !== '*') {
        if (!META_FIELDS.includes(field)) {
          report('SN303', `\`$meta.${rname}.${field}\` is not a status field.${didYouMean(field, META_FIELDS)}`, n.start);
        } else if (PAGE_FIELDS.includes(field) && !r.paginate) {
          report('SN303', `\`$meta.${rname}.${field}\` is a pagination field, but \`${rname}\` has no \`paginate\``, n.start);
        } else if (field === 'page' && r.paginate !== 'offset' && !r.jumps) {
          report('SN303', `\`$meta.${rname}.page\` exists only with \`paginate="offset"\`, or \`paginate="keyset"\` with \`offset-param\``, n.start);
        }
      }
    }
  }

  // ---- walking
  function ident(n: acorn.Identifier & Node, locals: Locals, shorthand = false) {
    const res = resolve(n.name, locals, n.start);
    if (!res) return;
    if (res.kind === 'ns') {
      report('SN206', `namespace \`${n.name}\` must be used as \`${n.name}.<member>()\``, n.start);
      return;
    }
    if (res.kind === 'helper' && BUILTIN_HELPERS.includes(n.name) && !page.helpers.has(n.name)) page.usedHelpers.add(n.name);
    else if (res.kind === 'helper') page.usedHelpers.add(n.name);
    let sid: number | undefined;
    if (res.kind === 'state') sid = res.sid;
    if (res.kind === 'loop' && res.entry.kind === 'index') usesIndex = true;
    if (res.kind === 'let') {
      // the inlined expression reads what the let reads
      for (const d of res.entry.deps) deps.add(d);
      if (res.entry.usesEl) usesEl = true;
      if (res.entry.usesIndex) usesIndex = true;
    }
    const text = emitName(n.name, res, sid);
    if (text !== n.name || shorthand) edits.push({ start: n.start, end: n.end, text: shorthand ? `${n.name}: ${text}` : text });
  }

  function declareParams(params: acorn.Pattern[], locals: Locals, info: LocalInfo | null): Locals {
    const next = new Map(locals);
    params.forEach((p, i) => {
      const names: string[] = [];
      collectPattern(p as Node, names, next);
      for (const nm of names) next.set(nm, i === 0 && p.type === 'Identifier' && info ? info : { alias: null, resource: info?.resource ?? null });
    });
    return next;
  }

  function collectPattern(p: Node, out: string[], locals: Locals) {
    switch (p.type) {
      case 'Identifier': out.push(p.name); break;
      case 'ObjectPattern':
        for (const prop of p.properties) {
          if (prop.type === 'RestElement') collectPattern(prop.argument as Node, out, locals);
          else { if (prop.computed) visit(prop.key as Node, locals); collectPattern(prop.value as Node, out, locals); }
        }
        break;
      case 'ArrayPattern': for (const el of p.elements) if (el) collectPattern(el as Node, out, locals); break;
      case 'RestElement': collectPattern(p.argument as Node, out, locals); break;
      case 'AssignmentPattern': collectPattern(p.left as Node, out, locals); visit(p.right as Node, locals); break;
      default: report('SN401', `unsupported parameter pattern`, p.start);
    }
  }

  function visitFunction(fn: acorn.ArrowFunctionExpression & Node, locals: Locals, elementInfo: LocalInfo | null) {
    if (fn.async) report('SN203', '`async` functions are not allowed in expressions', fn.start);
    const inner = declareParams(fn.params, locals, elementInfo);
    visit(fn.body as Node, inner);
  }

  function visitChain(n: Node, locals: Locals, isCallee: boolean) {
    // dependency of the whole chain (minus the method name when it is called)
    if (mode !== 'optimistic' || true) {
      const cp = chainPath(n, locals);
      if (cp && cp.segs) {
        const segs = isCallee && n.type === 'MemberExpression' ? cp.segs.slice(0, -1) : cp.segs;
        if (mode === 'value' || isCallee || true) addDep(segs.length ? segs : null);
      }
    }
    visitMemberParts(n, locals);
  }

  function visitMemberParts(n: Node, locals: Locals) {
    if (n.type === 'Identifier') return ident(n as acorn.Identifier & Node, locals);
    if (n.type === 'ChainExpression') return visitMemberParts((n as acorn.ChainExpression).expression as Node, locals);
    if (n.type !== 'MemberExpression') return visit(n, locals);
    const m = n as acorn.MemberExpression & Node;
    if (m.object.type === 'Identifier' && page.namespaces.has(m.object.name) && !locals.has(m.object.name)) {
      nsMember(m, locals);
      return;
    }
    if (m.object.type === 'Identifier' && m.object.name === '$meta') checkMeta(m, locals);
    else if (m.object.type === 'MemberExpression') {
      const root = leftmost(m);
      if (root?.type === 'Identifier' && root.name === '$meta') checkMeta(m, locals);
    }
    if (m.object.type === 'MemberExpression' || m.object.type === 'Identifier' || m.object.type === 'ChainExpression') visitMemberParts(m.object as Node, locals);
    else visit(m.object as Node, locals);
    if (!m.computed) {
      const pn = (m.property as acorn.Identifier).name;
      if (FORBIDDEN_KEYS.has(pn)) report('SN207', `access to \`.${pn}\` is not allowed`, m.property.start);
    } else if (m.property.type === 'Literal') {
      if (FORBIDDEN_KEYS.has(String((m.property as acorn.Literal).value))) report('SN207', `access to \`[${(m.property as acorn.Literal).raw}]\` is not allowed`, m.property.start);
    } else {
      edits.push({ start: m.property.start, end: m.property.start, text: '$k(' });
      edits.push({ start: m.property.end, end: m.property.end, text: ')' });
      visit(m.property as Node, locals);
    }
  }

  function leftmost(n: Node): Node | null {
    let cur: Node = n;
    while (cur.type === 'MemberExpression' || cur.type === 'CallExpression' || cur.type === 'ChainExpression') {
      if (cur.type === 'MemberExpression') cur = cur.object as Node;
      else if (cur.type === 'CallExpression') cur = cur.callee as Node;
      else cur = cur.expression as Node;
    }
    return cur;
  }

  function nsMember(m: acorn.MemberExpression & Node, _locals: Locals) {
    const ns = (m.object as acorn.Identifier).name;
    if (m.computed) {
      report('SN206', `namespace members must be named literally; \`${ns}[…]\` is refused. Put a dynamic choice in a helper`, m.start);
      return;
    }
    const member = (m.property as acorn.Identifier).name;
    const members = page.namespaces.get(ns)!;
    if (!members.has(member)) {
      report('SN206', `\`${ns}.${member}\` is not exported by namespace \`${ns}\`.${didYouMean(member, members)}`, m.start);
      return;
    }
    if (!page.usedNs.has(ns)) page.usedNs.set(ns, new Set());
    page.usedNs.get(ns)!.add(member);
    addDep(['$locale']);
    edits.push({ start: m.start, end: m.end, text: `${ns}$${member}` });
  }

  /**
   * A write through a callback parameter that stands for "any element" (`data.forEach(row => row.x = 1)`)
   * records the element at runtime: the expression is wrapped in `$.$m(row, …)` and its `*` becomes `~`,
   * so only rows holding a marked element re-evaluate.
   */
  function track(cp: ChainPath, segs: string[], expr: Node): string[] {
    const alias = cp.res.kind === 'local' ? cp.res.info.alias : null;
    if (!alias || alias[alias.length - 1] !== '*' || segs[alias.length - 1] !== '*') return segs;
    edits.push({ start: expr.start, end: expr.start, text: `$.$m(${cp.root}, ` }, { start: expr.end, end: expr.end, text: ')' });
    return segs.map((x, i) => (i === alias.length - 1 ? '~' : x));
  }

  function writePath(target: Node, locals: Locals, at: number, expr: Node) {
    if (target.type === 'Identifier' && target.name === '$locale') { writes.add('$locale'); return; }
    if (target.type !== 'Identifier' && target.type !== 'MemberExpression') {
      report('SN203', 'only state variables and their properties can be assigned', at);
      return;
    }
    const cp = chainPath(target, locals);
    if (!cp) { report('SN203', 'only state variables and their properties can be assigned', at); return; }
    if (cp.res.kind === 'let') {
      report('SN203', `\`${cp.root}\` is derived (\`data-sn-let\`) and cannot be assigned; assign the state it is computed from`, at);
      return;
    }
    if (cp.resource) {
      report('SN205', `\`${src.slice(target.start, target.end)}\` mutates a resource. Use \`patch('${cp.resource}', …, {…})\``, at,
        'resources are read-only in expressions; copy with structuredClone() to edit');
      return;
    }
    if (cp.res.kind === 'magic' && cp.root === '$url') {
      if (!cp.segs || cp.segs.length !== 2) { report('SN203', 'assign a parameter: `$url.<param> = …`', at); return; }
      if (page.pathParams.has(cp.segs[1]!)) { report('SN203', `\`$url.${cp.segs[1]}\` is a path parameter (\`data-sn-path\`) and read-only; link to the other URL instead`, at); return; }
      writes.add(cp.segs.join('.'));
      return;
    }
    if (cp.res.kind === 'state' || ((cp.res.kind === 'loop' || cp.res.kind === 'local') && cp.segs)) {
      if (cp.res.kind === 'loop' && cp.segs!.length === (cp.res.entry.alias?.length ?? 0)) {
        report('SN203', `loop variable \`${cp.root}\` cannot be reassigned`, at);
        return;
      }
      writes.add(track(cp, cp.segs!, expr).join('.'));
      return;
    }
    report('SN203', `\`${src.slice(target.start, target.end)}\` cannot be assigned; only state variables, \`$url.<param>\` and \`$locale\` can`, at);
  }

  function visitCall(n: acorn.CallExpression & Node, locals: Locals) {
    const callee = (n.callee.type === 'ChainExpression' ? n.callee.expression : n.callee) as Node;
    let elementInfo: LocalInfo | null = null;
    if (callee.type === 'MemberExpression') {
      const m = callee as acorn.MemberExpression & Node;
      const method = !m.computed && m.property.type === 'Identifier' ? m.property.name : null;
      const isNs = m.object.type === 'Identifier' && page.namespaces.has(m.object.name) && !locals.has(m.object.name);
      if (!isNs) {
        const recv = chainPath(m.object as Node, locals);
        if (method && recv) {
          if (ELEMENT_CALLBACKS.has(method)) {
            elementInfo = { alias: recv.segs ? [...recv.segs, '*'] : null, resource: recv.resource };
          }
          if (!READ_ONLY.has(method)) {
            if (recv.resource && MUTATORS.has(method)) {
              report('SN205', `\`${src.slice(m.start, m.end)}()\` mutates a resource. Use \`patch('${recv.resource}', …)\` or copy with structuredClone()`, n.start);
            } else if (mode === 'value' && MUTATORS.has(method) && recv.segs && recv.res.kind === 'state') {
              report('SN203', `value expressions cannot change state; move \`${method}()\` to \`data-sn-on-*\``, n.start);
            } else if (mode === 'handler' && recv.segs && recv.res.kind !== 'magic' && !recv.resource) {
              // a known mutator changes the list structure (`#`), not the elements; unknown methods may change anything
              writes.add(track(recv, recv.segs, n).join('.') + (MUTATORS.has(method) ? '.#' : ''));
            } else if (mode === 'handler' && recv.segs && recv.root === '$url') {
              writes.add(recv.segs.slice(0, 2).join('.'));
            }
          }
        }
        // `Object.assign(target, …)` and friends write to their first argument like `target.x = …` would;
        // a forbidden key named literally in an `Object.*` call reaches what `.constructor` is refused for
        if (m.object.type === 'Identifier' && m.object.name === 'Object' && !locals.has('Object') && method) {
          for (const a of n.arguments) {
            if (a.type === 'Literal' && FORBIDDEN_KEYS.has(String((a as acorn.Literal).value))) report('SN207', `\`${(a as acorn.Literal).raw}\` is not allowed as an argument of \`Object.${method}()\``, a.start);
          }
          const target = n.arguments[0];
          const cp = OBJECT_MUTATORS.has(method) && target && (target.type === 'Identifier' || target.type === 'MemberExpression') ? chainPath(target as Node, locals) : null;
          if (cp) {
            if (cp.resource) report('SN205', `\`Object.${method}(${src.slice(target!.start, target!.end)}, …)\` mutates a resource. Use \`patch('${cp.resource}', …)\` or copy with structuredClone()`, n.start);
            else if (cp.segs && cp.res.kind === 'state') {
              if (mode === 'value') report('SN203', `value expressions cannot change state; move \`Object.${method}()\` to \`data-sn-on-*\``, n.start);
              else if (mode === 'handler') writes.add(track(cp, cp.segs, n).join('.'));
            }
          }
        }
        // time and randomness
        if (mode === 'value' && m.object.type === 'Identifier' && !m.computed) {
          const o = m.object.name, p = (m.property as acorn.Identifier).name;
          if ((o === 'Date' && p === 'now') || (o === 'Math' && p === 'random')) {
            report('SN502', `\`${o}.${p}()\` in a binding never updates. Use \`$now\``, n.start);
          }
        }
      }
      visitChain(callee, locals, true);
    } else if (callee.type === 'Identifier') {
      const res = resolveQuiet(callee.name, locals);
      ident(callee as acorn.Identifier & Node, locals);
      if (res?.kind === 'store') storeCall(callee.name, n);
      else if (res?.kind === 'helper') {
        if (BUILTIN_HELPERS.includes(callee.name)) addDep(['$locale']);
        else if (mode === 'handler') {
          for (const a of n.arguments) {
            const cp = a.type === 'Identifier' || a.type === 'MemberExpression' ? chainPath(a as Node, locals) : null;
            if (cp?.segs && cp.res.kind === 'state') writes.add(cp.segs.slice(0, 2).join('.'));
          }
        }
      }
    } else {
      visit(callee, locals);
    }
    for (const a of n.arguments) {
      if (a.type === 'ArrowFunctionExpression') visitFunction(a as acorn.ArrowFunctionExpression & Node, locals, elementInfo);
      else visit(a as Node, locals);
    }
  }

  function storeCall(name: string, n: acorn.CallExpression & Node) {
    if (mode === 'value') {
      report('SN203', `value expressions cannot call \`${name}()\`; move it to a handler`, n.start);
      return;
    }
    const first = n.arguments[0];
    // an element-less handler has no nearest dialog or form, nothing to dispatch from
    if (opts.noElement && (name === 'reset' || name === 'emit' || (name === 'close' && !first))) {
      report('SN203', `\`${name}()\` needs an element; an \`<${opts.noElement}>\` handler has none${name === 'close' ? `: name the dialog, \`close('id')\`` : ''}`, n.start);
      return;
    }
    if (name === 'showModal' || (name === 'close' && first)) {
      if (!first || first.type !== 'Literal' || typeof first.value !== 'string') {
        report('SN309', `\`${name}()\` takes the dialog's \`id\` as a string literal`, n.start);
      } else if (!page.dialogs.has(first.value)) {
        report('SN309', `no \`<dialog id="${first.value}">\` on this page.${didYouMean(first.value, page.dialogs)}`, first.start);
      }
      return;
    }
    if (['refresh', 'upsert', 'patch', 'remove', 'page'].includes(name)) {
      if (!first || first.type !== 'Literal' || typeof first.value !== 'string') {
        report('SN301', `\`${name}()\` takes the resource name as a string literal`, n.start);
        return;
      }
      const r = page.resources.get(first.value);
      if (!r) {
        report('SN301', `resource \`${first.value}\` is not declared on this page.${didYouMean(first.value, page.resources.keys())}`, first.start);
        return;
      }
      if (name === 'page') {
        if (!r.paginate) report('SN303', `\`${first.value}\` has no \`paginate\`; \`page()\` needs a paginated resource`, n.start);
        const target = n.arguments[1];
        const named = target?.type === 'Literal' && typeof target.value === 'string' ? target.value : null;
        if (r.paginate && r.paginate !== 'offset' && !named && !(r.paginate === 'keyset' && r.jumps)) {
          report('SN304', r.paginate === 'keyset'
            ? 'keyset pagination cannot jump to a page number. Add `offset-param` if the server also accepts an offset, or use `paginate="offset"`'
            : 'keyset pagination cannot jump to a page number. Use `paginate="offset"`', target?.start ?? n.start);
        } else if (r.paginate === 'append' && named && named !== 'next') {
          report('SN304', '`append` pagination only supports `page(…, \'next\')`', target!.start);
        } else if (named && !['first', 'prev', 'next', 'last'].includes(named)) {
          report('SN401', `\`page()\` targets are 'first', 'prev', 'next', 'last' or a page number`, target!.start);
        }
      }
    }
  }

  function visit(n: Node, locals: Locals): void {
    switch (n.type) {
      case 'Identifier': {
        const res = resolveQuiet(n.name, locals);
        if (res) { const b = basePath(n.name, res); addDep(b.segs); }
        ident(n, locals);
        return;
      }
      case 'MemberExpression':
      case 'ChainExpression':
        visitChain(n, locals, false);
        return;
      case 'CallExpression':
        visitCall(n, locals);
        return;
      case 'NewExpression':
        if (mode === 'value' && n.callee.type === 'Identifier' && n.callee.name === 'Date' && n.arguments.length === 0) {
          report('SN502', '`new Date()` in a binding never updates. Use `$now`', n.start);
        }
        visit(n.callee as Node, locals);
        for (const a of n.arguments) visit(a as Node, locals);
        return;
      case 'ArrowFunctionExpression':
        visitFunction(n, locals, null);
        return;
      case 'FunctionExpression':
        report('SN203', 'use an arrow function instead of `function`', n.start);
        return;
      case 'ClassExpression':
        report('SN203', 'classes are not allowed in expressions', n.start);
        return;
      case 'AssignmentExpression': {
        if (mode !== 'handler') {
          report('SN203', mode === 'optimistic' ? '`data-sn-optimistic` may only call `patch`, `upsert`, `remove`' : 'value expressions cannot assign; move this to `data-sn-on-*`', n.start);
          return;
        }
        if (n.left.type === 'ObjectPattern' || n.left.type === 'ArrayPattern') {
          report('SN203', 'destructuring assignment is not supported in handlers', n.start);
          return;
        }
        writePath(n.left as Node, locals, n.start, n);
        visitMemberParts(n.left as Node, locals);
        visit(n.right as Node, locals);
        return;
      }
      case 'UpdateExpression':
        if (mode !== 'handler') { report('SN203', 'value expressions cannot use `++`/`--`; move this to `data-sn-on-*`', n.start); return; }
        writePath(n.argument as Node, locals, n.start, n);
        visitMemberParts(n.argument as Node, locals);
        return;
      case 'UnaryExpression':
        if (n.operator === 'delete') {
          if (mode !== 'handler') { report('SN203', 'value expressions cannot use `delete`', n.start); return; }
          writePath(n.argument as Node, locals, n.start, n);
          visitMemberParts(n.argument as Node, locals);
          return;
        }
        visit(n.argument as Node, locals);
        return;
      case 'AwaitExpression':
        report('SN203', '`await` is not allowed in expressions', n.start);
        return;
      case 'ImportExpression':
        report('SN203', '`import()` is not allowed in expressions', n.start);
        return;
      case 'YieldExpression':
        report('SN203', '`yield` is not allowed in expressions', n.start);
        return;
      case 'ThisExpression':
        report('SN202', '`this` is not available in expressions; use `$el`', n.start);
        return;
      case 'MetaProperty':
        report('SN202', `\`${src.slice(n.start, n.end)}\` is not available in expressions`, n.start);
        return;
      case 'ObjectExpression':
        for (const p of n.properties) {
          if (p.type === 'SpreadElement') { visit(p.argument as Node, locals); continue; }
          if (p.computed) visit(p.key as Node, locals);
          if (p.shorthand && p.value.type === 'Identifier') {
            const res = resolveQuiet(p.value.name, locals);
            if (res) addDep(basePath(p.value.name, res).segs);
            ident(p.value as acorn.Identifier & Node, locals, true);
          } else if (p.kind !== 'init' || p.method) {
            report('SN203', 'methods and accessors are not allowed in object literals', p.start);
          } else visit(p.value as Node, locals);
        }
        return;
      case 'TaggedTemplateExpression':
        visit(n.tag as Node, locals);
        visit(n.quasi as Node, locals);
        return;
      case 'SequenceExpression':
        for (const e of n.expressions) visit(e as Node, locals);
        return;
      default:
        for (const key of Object.keys(n) as Array<keyof typeof n>) {
          if (key === 'type' || key === 'start' || key === 'end' || key === 'loc' || key === 'range') continue;
          const v = n[key] as unknown;
          if (Array.isArray(v)) { for (const c of v) if (c && typeof c === 'object' && 'type' in c) visit(c as Node, locals); }
          else if (v && typeof v === 'object' && 'type' in (v as object)) visit(v as Node, locals);
        }
    }
  }

  // ---- optimistic: only patch/upsert/remove calls
  function checkOptimistic(e: Node) {
    if (e.type !== 'CallExpression' || e.callee.type !== 'Identifier' || !['patch', 'upsert', 'remove'].includes(e.callee.name)) {
      report('SN204', '`data-sn-optimistic` may only call `patch`, `upsert`, `remove`', e.start, 'local state and side effects cannot be rolled back; put them in `data-sn-then`');
      return false;
    }
    return true;
  }

  // ---- objects
  let entries: ObjectEntry[] | undefined;
  const root = new Map<string, LocalInfo>();
  if (opts.object) {
    if (ast!.type !== 'ObjectExpression') {
      report('SN401', 'expected an object literal `{ … }`', 0);
      return fail();
    }
    entries = [];
    for (const p of (ast as acorn.ObjectExpression).properties) {
      if (p.type === 'SpreadElement') {
        report(opts.object === 'state' ? 'SN401' : 'SN207', 'spread (`...`) is not allowed here; list each key literally', p.start);
        continue;
      }
      let key: string;
      if (!p.computed && p.key.type === 'Identifier') key = p.key.name;
      else if (p.key.type === 'Literal' && !p.computed) key = String(p.key.value);
      else if (opts.object === 'any-keys') key = '';
      else {
        report(opts.object === 'state' ? 'SN401' : 'SN207', 'keys must be literal; computed keys are not allowed here', p.start);
        continue;
      }
      if (p.kind !== 'init' || p.method) { report('SN203', 'methods and accessors are not allowed in object literals', p.start); continue; }
      const depsBefore = new Set(deps);
      deps.clear();
      if (p.computed) visit(p.key as Node, root);
      if (p.shorthand && p.value.type === 'Identifier') {
        const res = resolveQuiet(p.value.name, root);
        if (res) addDep(basePath(p.value.name, res).segs);
        ident(p.value as acorn.Identifier & Node, root, true);
      } else visit(p.value as Node, root);
      const own = [...deps];
      for (const d of depsBefore) deps.add(d);
      entries.push({ key, code: '', deps: own, offset: p.start, literal: p.value.type === 'Literal' });
    }
  } else {
    for (const e of body) {
      if (mode === 'optimistic' && !checkOptimistic(e)) continue;
      if (mode === 'optimistic') {
        // arguments are read like values; only the call itself is allowed
        const c = e as acorn.CallExpression & Node;
        ident(c.callee as acorn.Identifier & Node, root);
        storeCall((c.callee as acorn.Identifier).name, c);
        for (const a of c.arguments) visit(a as Node, root);
      } else visit(e, root);
    }
  }

  // ---- codegen
  const out = applyEdits(src, edits);
  let code: string;
  if (mode === 'value' || opts.object) code = `($) => (${out})`;
  else code = `($) => {${out}\n}`;

  if (entries && opts.object) {
    // per-entry code for object literals, so bindings can write key by key
    const slice = (start: number, end: number) => applyEdits(
      src.slice(start, end),
      edits.filter((e) => e.start >= start && e.end <= end).map((e) => ({ ...e, start: e.start - start, end: e.end - start })),
    );
    let i = 0;
    for (const p of (ast as acorn.ObjectExpression).properties) {
      if (p.type === 'SpreadElement') continue;
      const entry = entries[i];
      if (!entry || entry.offset !== p.start) continue;
      let value = slice(p.value.start, p.value.end);
      if (p.shorthand) value = value.slice(value.indexOf(': ') + 2);
      entry.code = p.computed ? `($) => [${slice(p.key.start, p.key.end)}, ${value}]` : `($) => (${value})`;
      i++;
    }
  }

  let path: string[] | null = null;
  let resource: string | null = null;
  if (body.length === 1 && !opts.object) {
    const e = body[0]!;
    if (e.type === 'Identifier' || e.type === 'MemberExpression') {
      const cp = chainPath(e, root);
      if (cp) { path = cp.segs; resource = cp.resource; }
    }
    if (!resource) {
      const l = leftmost(e);
      if (l?.type === 'Identifier') {
        const res = resolveQuiet(l.name, root);
        if (res) resource = basePath(l.name, res).resource;
      }
    }
  }

  return { ok, code, inner: out, deps: [...deps].sort(), writes: [...writes].sort(), usesEl, usesIndex, entries, path, resource, ast, ...(opts.payload ? { payloadNames: [...payloadNames].sort(), payloadStates: [...payloadStates].sort() } : {}) };
}

export function applyEdits(src: string, edits: Edit[]): string {
  const sorted = [...edits].sort((a, b) => b.start - a.start || (b.end - b.start) - (a.end - a.start));
  let out = src;
  for (const e of sorted) out = out.slice(0, e.start) + e.text + out.slice(e.end);
  return out;
}
