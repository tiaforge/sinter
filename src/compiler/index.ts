import * as acorn from 'acorn';
import { compileParts, type CompileOptions, type CompileResult, type CompiledParts, type HelperManifest } from './compile.js';

export type { CompileOptions, CompileResult, CompiledParts, HelperManifest };
export type { Diagnostic } from './diagnostics.js';
export { formatDiagnostic, CODES } from './diagnostics.js';
export { compileParts };

export const PACKAGE = '@tiaforge/sinter';

/** Compiles annotated HTML into a rewritten page and its page module. Pure and deterministic. */
export function compile(html: string, options: CompileOptions): CompileResult {
  const parts = compileParts(html, options);
  return { html: parts.html, module: pageModule(parts, options), diagnostics: parts.diagnostics, files: parts.files };
}

export function pageModule(parts: CompiledParts, options: Pick<CompileOptions, 'helpers' | 'dev' | 'config'>): string {
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
 * becomes a namespace whose members are read from `x.js` the same way.
 */
export function readHelperManifest(
  source: string,
  options: { module: string; file: string; readFile: (path: string) => string; resolve?: (spec: string, from: string) => string | null },
): HelperManifest {
  const manifest: HelperManifest = { module: options.module, names: [], namespaces: {} };
  const resolve = options.resolve ?? ((spec: string, from: string) => (spec.startsWith('.') ? joinPath(from, spec) : null));
  const { names, namespaces } = exportsOf(source);
  manifest.names = names;
  for (const [ns, spec] of namespaces) {
    const path = resolve(spec, options.file);
    let members: string[] = [];
    if (path) {
      try { members = exportsOf(options.readFile(path)).names; } catch { members = []; }
    }
    const modSpec = spec.startsWith('.') ? joinPath(options.module, spec) : spec;
    manifest.namespaces[ns] = { module: modSpec, members };
  }
  return manifest;
}

function exportsOf(source: string): { names: string[]; namespaces: Array<[string, string]> } {
  const ast = acorn.parse(source, { ecmaVersion: 'latest', sourceType: 'module' });
  const names: string[] = [];
  const namespaces: Array<[string, string]> = [];
  for (const st of ast.body) {
    if (st.type === 'ExportNamedDeclaration') {
      const d = st.declaration;
      if (d?.type === 'FunctionDeclaration' && d.id) names.push(d.id.name);
      else if (d?.type === 'ClassDeclaration' && d.id) names.push(d.id.name);
      else if (d?.type === 'VariableDeclaration') {
        for (const v of d.declarations) if (v.id.type === 'Identifier') names.push(v.id.name);
      }
      for (const s of st.specifiers) {
        const exported = s.exported.type === 'Identifier' ? s.exported.name : String(s.exported.value);
        if (exported !== 'default') names.push(exported);
      }
    } else if (st.type === 'ExportAllDeclaration' && st.exported) {
      const ns = st.exported.type === 'Identifier' ? st.exported.name : String(st.exported.value);
      namespaces.push([ns, String(st.source.value)]);
    }
  }
  return { names: [...new Set(names)].sort(), namespaces };
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
