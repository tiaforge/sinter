import * as acorn from 'acorn';
import { tsPlugin } from '@sveltejs/acorn-typescript';
import { compileParts, type CompileOptions, type CompileResult, type CompiledParts, type EarlyParts, type HelperManifest, type HelperOrigin } from './compile.js';

export type { CompileOptions, CompileResult, CompiledParts, EarlyParts, HelperManifest, HelperOrigin };
export type { Diagnostic } from './diagnostics.js';
export type { CheckUnit } from './check-unit.js';
export { formatDiagnostic, docsUrl, CODES } from './diagnostics.js';
export { DIAGNOSTIC_DOCS, type DiagnosticDoc } from './diagnostic-docs.js';
export { compileParts };
export { COMPLEXITY_DEFAULTS, type ComplexityLimits, type ComplexityOptions } from './complexity.js';

export const PACKAGE = '@tiaforge-ui/sinter';

/** Compiles annotated HTML into a rewritten page and its page module. Pure and deterministic. */
export function compile(html: string, options: CompileOptions): CompileResult {
  const parts = compileParts(html, options);
  const out: CompileResult = { html: parts.html, module: pageModule(parts, options), diagnostics: parts.diagnostics, files: parts.files };
  if (parts.check) out.check = parts.check;
  if (parts.early !== undefined) out.early = earlyModule(parts.early, options);
  return out;
}

/**
 * The page's early module: the app's early module first (it runs before any binding, e.g. to pick
 * the language), then the early bindings with only the helpers they call. Null when there is
 * neither.
 */
export function earlyModule(early: EarlyParts | null, options: Pick<CompileOptions, 'helpers' | 'early'>): string | null {
  const app = options.early?.module ?? null;
  if (!early && !app) return null;
  const lines: string[] = [];
  if (app) lines.push(`import ${JSON.stringify(app)};`);
  if (early) {
    lines.push(`import { early, $k } from '${PACKAGE}/early';`);
    // each from the module that declares it: past the helpers module and barrels, whose other
    // exports (a namespace object of every message) would otherwise load before the first paint
    const byModule = new Map<string, string[]>();
    const add = (mod: string, spec: string) => byModule.set(mod, [...(byModule.get(mod) ?? []), spec]);
    const as = (o: HelperOrigin, local: string) => (o.name === local ? local : `${o.name} as ${local}`);
    if (options.helpers.module) for (const h of early.helpers) {
      const o = options.helpers.from?.[h];
      add(o?.module ?? options.helpers.module, o ? as(o, h) : h);
    }
    for (const [ns, members] of Object.entries(early.namespaces)) {
      const info = options.helpers.namespaces[ns]!;
      for (const m of members) {
        const o = info.from?.[m];
        add(o?.module ?? info.module, `${o?.name ?? m} as ${ns}$${m}`);
      }
    }
    for (const [mod, specs] of byModule) lines.push(`import { ${specs.join(', ')} } from ${JSON.stringify(mod)};`);
    lines.push('', `const ir = ${JSON.stringify(early.ir)};`, 'const fns = [');
    for (const f of early.fns) lines.push(`  ${f},`);
    lines.push('];', '', 'early(document, { ir, fns });');
  }
  return lines.join('\n') + '\n';
}

export function pageModule(parts: CompiledParts, options: Pick<CompileOptions, 'helpers' | 'dev' | 'config' | 'actions'>): string {
  const lines: string[] = [];
  const core = ['mount', '$k', ...parts.helpers.builtin];
  lines.push(`import { ${core.join(', ')} } from '${PACKAGE}';`);
  for (const f of parts.features) lines.push(`import ${f} from '${PACKAGE}/${f}';`);
  if (parts.helpers.user.length && options.helpers.module) {
    lines.push(`import { ${parts.helpers.user.join(', ')} } from ${JSON.stringify(options.helpers.module)};`);
  }
  for (const [ns, members] of Object.entries(parts.namespaces)) {
    const mod = options.helpers.namespaces[ns]!.module;
    lines.push(`import { ${members.map((m) => `${m} as ${ns}$${m}`).join(', ')} } from ${JSON.stringify(mod)};`);
  }
  // actions (`data-sn-call`): imported as `$a$name` / `$a$ns$member`, only those the page calls
  const acts = options.actions;
  if (acts?.module) {
    const direct = parts.calls.filter((c) => !c.includes('.'));
    if (direct.length) lines.push(`import { ${direct.map((c) => `${c} as $a$${c}`).join(', ')} } from ${JSON.stringify(acts.module)};`);
    const byNs = new Map<string, string[]>();
    for (const c of parts.calls.filter((x) => x.includes('.'))) {
      const [ns, member] = c.split('.') as [string, string];
      byNs.set(ns, [...(byNs.get(ns) ?? []), member]);
    }
    for (const [ns, members] of byNs) {
      lines.push(`import { ${members.map((x) => `${x} as $a$${ns}$${x}`).join(', ')} } from ${JSON.stringify(acts.namespaces[ns]!.module)};`);
    }
  }
  if (options.config) lines.push(`import ${JSON.stringify(options.config)};`);
  lines.push('');
  lines.push(`const ir = ${JSON.stringify(parts.ir)};`);
  lines.push('const fns = [');
  for (const f of parts.fns) lines.push(`  ${f},`);
  lines.push('];');
  lines.push('');
  lines.push(`mount(document, { ir, fns, features: [${parts.features.join(', ')}] });`);
  return lines.join('\n') + '\n';
}

/**
 * Reads a helpers module's export names statically. `export * as m from './x.js'`
 * becomes a namespace whose members are read from `x.js` the same way. `export * from './y.js'`
 * re-exports (e.g. paraglide's message index) are followed, relative paths only.
 */
export function readHelperManifest(
  source: string,
  options: { module: string; file: string; readFile: (path: string) => string; resolve?: (spec: string, from: string) => string | null },
): HelperManifest {
  const manifest: HelperManifest = { module: options.module, names: [], namespaces: {} };
  const resolve = options.resolve ?? ((spec: string, from: string) => (spec.startsWith('.') ? joinPath(from, spec) : null));
  const read = (file: string): ModuleExports | null => {
    try { return exportsOf(options.readFile(file), file); } catch { return null; }
  };
  /** the module's own value exports plus those of its `export *` re-exports, transitively; `origin`: name → declaring file and name */
  const valueNames = (file: string, exports: ModuleExports, seen: Set<string>, origin?: Map<string, { file: string; name: string }>): string[] => {
    const names = new Set(exports.names);
    for (const n of exports.names) {
      if (origin?.has(n)) continue;
      const re = exports.named.get(n), at = re && re.spec.startsWith('.') ? resolve(re.spec, file) : null;
      origin?.set(n, at ? { file: at, name: re!.name } : { file, name: n });
    }
    for (const spec of exports.reexports) {
      const path = spec.startsWith('.') ? resolve(spec, file) : null;
      if (!path || seen.has(path)) continue;
      seen.add(path);
      const sub = read(path);
      if (sub) for (const n of valueNames(path, sub, seen, origin)) names.add(n);
    }
    return [...names].sort();
  };
  const top = exportsOf(source, options.file);
  const own = new Map<string, { file: string; name: string }>();
  manifest.names = valueNames(options.file, top, new Set([options.file]), own);
  const fromOf = (origin: Map<string, { file: string; name: string }>, file: string, spec: string) => {
    const from: Record<string, HelperOrigin> = {};
    for (const [n, o] of origin) if (o.file !== file) from[n] = { module: joinPath(spec, relPath(file, o.file)), name: o.name };
    return Object.keys(from).length ? from : null;
  };
  const topFrom = fromOf(own, options.file, options.module);
  if (topFrom) manifest.from = topFrom;
  for (const [ns, spec] of top.namespaces) {
    const path = resolve(spec, options.file);
    const exports = path ? read(path) : null;
    const origin = new Map<string, { file: string; name: string }>();
    const members = path && exports ? valueNames(path, exports, new Set([path]), origin) : [];
    const modSpec = spec.startsWith('.') ? joinPath(options.module, spec) : spec;
    manifest.namespaces[ns] = { module: modSpec, members };
    // members declared in a re-exported module (a barrel such as paraglide's message index makes a
    // namespace object; importing past it keeps the early chunk to what it calls)
    const from = path && spec.startsWith('.') ? fromOf(origin, path, modSpec) : null;
    if (from) manifest.namespaces[ns]!.from = from;
  }
  return manifest;
}

interface ModuleExports {
  /** value exports declared or listed in the module itself */
  names: string[];
  /** `export * as ns from 'spec'` */
  namespaces: Array<[string, string]>;
  /** `export * from 'spec'` */
  reexports: string[];
  /** `export { name as exported } from 'spec'`, by exported name */
  named: Map<string, { spec: string; name: string }>;
}

/** acorn extended with TypeScript syntax, for `.ts` helper and namespace modules (and the LSP's extract refactoring) */
let tsParser: typeof acorn.Parser | null = null;

export function parseModule(source: string, file: string): acorn.Program {
  const options: acorn.Options = { ecmaVersion: 'latest', sourceType: 'module' };
  if (!/\.[cm]?tsx?$/.test(file)) return acorn.parse(source, options);
  tsParser ??= acorn.Parser.extend(tsPlugin() as never);
  return tsParser.parse(source, options) as acorn.Program;
}

/** Value exports only: type-only exports (`export type`, `export interface`, `export { type X }`) are skipped. */
function exportsOf(source: string, file: string): ModuleExports {
  const ast = parseModule(source, file);
  const names: string[] = [];
  const namespaces: Array<[string, string]> = [];
  const reexports: string[] = [];
  const named = new Map<string, { spec: string; name: string }>();
  const typeOnly = (n: unknown) => (n as { exportKind?: string }).exportKind === 'type';
  for (const st of ast.body) {
    if (typeOnly(st)) continue;
    if (st.type === 'ExportNamedDeclaration') {
      const d = st.declaration;
      if (d?.type === 'FunctionDeclaration' && d.id) names.push(d.id.name);
      else if (d?.type === 'ClassDeclaration' && d.id) names.push(d.id.name);
      else if ((d?.type as string) === 'TSEnumDeclaration') names.push((d as unknown as { id: { name: string } }).id.name);
      else if (d?.type === 'VariableDeclaration') {
        for (const v of d.declarations) if (v.id.type === 'Identifier') names.push(v.id.name);
      }
      for (const s of st.specifiers) {
        if (typeOnly(s)) continue;
        const exported = s.exported.type === 'Identifier' ? s.exported.name : String(s.exported.value);
        if (exported !== 'default') names.push(exported);
        const local = s.local.type === 'Identifier' ? s.local.name : String(s.local.value);
        if (st.source && exported !== 'default' && local !== 'default') named.set(exported, { spec: String(st.source.value), name: local });
      }
    } else if (st.type === 'ExportAllDeclaration' && st.exported) {
      const ns = st.exported.type === 'Identifier' ? st.exported.name : String(st.exported.value);
      namespaces.push([ns, String(st.source.value)]);
    } else if (st.type === 'ExportAllDeclaration') {
      reexports.push(String(st.source.value));
    }
  }
  return { names: [...new Set(names)].sort(), namespaces, reexports, named };
}

/** `to` relative to the directory of `from` (both absolute, `/`-separated), as `./x.js` or `../y/x.js` */
function relPath(from: string, to: string): string {
  const a = from.split('/').slice(0, -1), b = to.split('/');
  let i = 0;
  while (i < a.length && i < b.length - 1 && a[i] === b[i]) i++;
  const up = a.length - i;
  return (up ? '../'.repeat(up) : './') + b.slice(i).join('/');
}

function joinPath(from: string, spec: string): string {
  const dir = from.slice(0, from.lastIndexOf('/') + 1);
  const out: string[] = [];
  for (const seg of (dir + spec).split('/')) {
    if (seg === '.') continue;
    if (seg === '..') out.pop(); else out.push(seg);
  }
  return out.join('/');
}
