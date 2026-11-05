import * as acorn from 'acorn';
import { tsPlugin } from '@sveltejs/acorn-typescript';
import { compileParts, type CompileOptions, type CompileResult, type CompiledParts, type HelperManifest } from './compile.js';

export type { CompileOptions, CompileResult, CompiledParts, HelperManifest };
export type { Diagnostic } from './diagnostics.js';
export type { CheckUnit } from './check-unit.js';
export { formatDiagnostic, docsUrl, CODES } from './diagnostics.js';
export { DIAGNOSTIC_DOCS, type DiagnosticDoc } from './diagnostic-docs.js';
export { compileParts };

export const PACKAGE = '@tiaforge-ui/sinter';

/** Compiles annotated HTML into a rewritten page and its page module. Pure and deterministic. */
export function compile(html: string, options: CompileOptions): CompileResult {
  const parts = compileParts(html, options);
  const out: CompileResult = { html: parts.html, module: pageModule(parts, options), diagnostics: parts.diagnostics, files: parts.files };
  if (parts.check) out.check = parts.check;
  return out;
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
  /** the module's own value exports plus those of its `export *` re-exports, transitively */
  const valueNames = (file: string, exports: ModuleExports, seen: Set<string>): string[] => {
    const names = new Set(exports.names);
    for (const spec of exports.reexports) {
      const path = spec.startsWith('.') ? resolve(spec, file) : null;
      if (!path || seen.has(path)) continue;
      seen.add(path);
      const sub = read(path);
      if (sub) for (const n of valueNames(path, sub, seen)) names.add(n);
    }
    return [...names].sort();
  };
  const top = exportsOf(source, options.file);
  manifest.names = valueNames(options.file, top, new Set([options.file]));
  for (const [ns, spec] of top.namespaces) {
    const path = resolve(spec, options.file);
    const exports = path ? read(path) : null;
    const members = path && exports ? valueNames(path, exports, new Set([path])) : [];
    const modSpec = spec.startsWith('.') ? joinPath(options.module, spec) : spec;
    manifest.namespaces[ns] = { module: modSpec, members };
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
}

/** acorn extended with TypeScript syntax, for `.ts` helper and namespace modules */
let tsParser: typeof acorn.Parser | null = null;

function parseModule(source: string, file: string): acorn.Program {
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
      }
    } else if (st.type === 'ExportAllDeclaration' && st.exported) {
      const ns = st.exported.type === 'Identifier' ? st.exported.name : String(st.exported.value);
      namespaces.push([ns, String(st.source.value)]);
    } else if (st.type === 'ExportAllDeclaration') {
      reexports.push(String(st.source.value));
    }
  }
  return { names: [...new Set(names)].sort(), namespaces, reexports };
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
