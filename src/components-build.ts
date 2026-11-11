// Components with a script, at build time: the generated base class a script extends
// (`import { TaskRingComponent } from './task-ring.html'`, served by the Vite plugin) and its
// types, `src/sinter.components.d.ts`, written like `src/sinter.messages.d.ts`.
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import * as parse5 from 'parse5';
import { parseExpressionAt } from 'acorn';
import type { DefaultTreeAdapterMap } from 'parse5';
import { COMPONENT_NAME } from './compiler/components.js';
import { typeExports } from './check/index.js';

type El = DefaultTreeAdapterMap['element'];
type Parent = DefaultTreeAdapterMap['parentNode'];

/** the module components' scripts import their base from */
export const COMPONENTS_MODULE = '@tiaforge-ui/sinter/components';
/** a component script's file extensions, in the order they are looked for */
export const SCRIPT_EXTS = ['.ts', '.js', '.mts', '.mjs'];

/** `task-ring` → `TaskRing` */
export const pascal = (name: string) => name.split('-').map((p) => p[0]!.toUpperCase() + p.slice(1)).join('');

/** The generated base class module of a component: `<Name>Component`, typed by `src/sinter.components.d.ts`. */
export function componentBase(name: string): string {
  return `import { Component } from '${COMPONENTS_MODULE}';\nexport class ${pascal(name)}Component extends Component {}\n`;
}

/** The app's components: the names of the files in `src/components/`. */
export function componentNames(root: string): string[] {
  try { return readdirSync(join(root, 'src', 'components')).filter((f) => f.endsWith('.html') && COMPONENT_NAME.test(f.slice(0, -5))).map((f) => f.slice(0, -5)).sort(); } catch { return []; }
}

/** The script beside a component's HTML file, or null. */
export function componentScript(htmlFile: string): string | null {
  const base = htmlFile.replace(/\.html$/, '');
  for (const ext of SCRIPT_EXTS) if (existsSync(base + ext)) return base + ext;
  return null;
}

interface Contract { props: string; emits: string; refs: string; state: string }

/** What a component's script sees, as TypeScript types: from its HTML alone. */
export function contractOf(html: string): Contract | null {
  const frag = parse5.parseFragment(html);
  const isEl = (n: unknown): n is El => !!n && typeof n === 'object' && 'tagName' in n;
  const attr = (el: El, n: string) => el.attrs.find((a) => a.name === n)?.value;
  const template = frag.childNodes.filter(isEl).find((t) => t.tagName === 'template' && attr(t, 'data-sn-component') !== undefined);
  if (!template) return null;
  const root = (template as DefaultTreeAdapterMap['template']).content.childNodes.find(isEl);
  const refs: string[] = [];
  const walk = (n: Parent, cond: boolean) => {
    for (const c of n.childNodes) {
      if (!isEl(c)) continue;
      const ref = attr(c, 'data-sn-ref');
      if (ref && /^[A-Za-z_$][\w$]*$/.test(ref)) {
        const t = c.tagName.includes('-') ? 'HTMLElement' : `HTMLElementTagNameMap[${JSON.stringify(c.tagName)}]`;
        refs.push(`${ref}: ${t}${cond ? ' | undefined' : ''}`);
      }
      if (c.tagName === 'slot') continue;
      walk(c, cond);
      if (c.tagName === 'template') walk((c as DefaultTreeAdapterMap['template']).content, cond || attr(c, 'data-sn-for') !== undefined || attr(c, 'data-sn-if') !== undefined || attr(c, 'data-sn-else') !== undefined);
    }
  };
  if (root) walk({ childNodes: [root] } as unknown as Parent, false);
  const props = (attr(template, 'data-sn-component') ?? '').trim() || '{}';
  const emits = (attr(template, 'data-sn-emits') ?? '').trim() || '{}';
  return { props, emits, refs: `{ ${refs.join('; ')} }`, state: stateType(root ? attr(root, 'data-sn-state') : undefined) };
}

/** A state literal's type, from its initial values (a value it cannot tell is `any`). */
function stateType(src: string | undefined): string {
  if (!src) return '{}';
  let o;
  try { o = parseExpressionAt(src, 0, { ecmaVersion: 'latest' }); } catch { return 'Record<string, any>'; }
  if (o.type !== 'ObjectExpression') return 'Record<string, any>';
  const fields: string[] = [];
  for (const p of o.properties) {
    if (p.type !== 'Property' || p.computed || p.key.type !== 'Identifier') continue;
    const v = p.value;
    const t = v.type === 'Literal' ? (typeof v.value === 'string' ? 'string' : typeof v.value === 'number' ? 'number' : typeof v.value === 'boolean' ? 'boolean' : 'any')
      : v.type === 'TemplateLiteral' ? 'string' : v.type === 'ArrayExpression' ? 'any[]' : v.type === 'UnaryExpression' && v.operator === '-' ? 'number' : 'any';
    fields.push(`${p.key.name}: ${t}`);
  }
  return `{ ${fields.join('; ')} }`;
}

/**
 * `src/sinter.components.d.ts`: for every component in `src/components/` with a script, the base
 * class its script imports from its HTML, typed by the HTML's declarations: `this.props` from
 * `data-sn-component`, `this.emit()` from `data-sn-emits`, `this.refs` from `data-sn-ref` (by tag),
 * `this.state` from the root's `data-sn-state`. Null when no component has a script.
 */
export function componentTypes(root: string, read: (file: string) => string = (f) => readFileSync(f, 'utf8')): string | null {
  const dir = join(root, 'src', 'components');
  let files: string[];
  try { files = readdirSync(dir).filter((f) => f.endsWith('.html') && COMPONENT_NAME.test(f.slice(0, -5))).sort(); } catch { return null; }
  const out: string[] = [];
  const typesFile = ['src/sinter.types.ts', 'src/sinter.types.d.ts'].map((f) => join(root, f)).find((f) => existsSync(f));
  const typeNames = typesFile ? typeExports(readFileSync(typesFile, 'utf8')) : [];
  const typesSpec = typesFile ? './' + relative(join(root, 'src'), typesFile).split(sep).join('/').replace(/\.(d\.)?ts$/, '') : null;
  for (const f of files) {
    const name = f.slice(0, -5);
    if (!componentScript(join(dir, f))) continue;
    let c: Contract | null = null;
    try { c = contractOf(read(join(dir, f))); } catch { /* reported by the compiler */ }
    if (!c) continue;
    const text = [c.props, c.emits].join(' ');
    const used = typeNames.filter((n) => new RegExp(`(?<![\\w$.])${n.replace(/\$/g, '\\$')}(?![\\w$])`).test(text));
    out.push(`declare module '*/${name}.html' {`);
    for (const n of used) out.push(`  type ${n} = import('${typesSpec}').${n};`);
    out.push(`  const Base: typeof import('${COMPONENTS_MODULE}').Component;`);
    out.push(`  /** the base of \`src/components/${name}.ts\`: props, events, refs and state as \`${f}\` declares them */`);
    out.push(`  export class ${pascal(name)}Component extends Base<${c.props}, ${c.emits}, ${c.refs}, ${c.state}> {}`);
    out.push('}');
  }
  if (!files.length) return null;
  // every component's name: what `<sn-component use>` takes, and a helper that picks one returns
  const names = files.map((f) => JSON.stringify(f.slice(0, -5))).join(' | ');
  return `// Generated by sinter from src/components/*.html. Do not edit.\n/** every component of the app, by its tag */\ntype ComponentName = ${names};\n${out.join('\n')}${out.length ? '\n' : ''}`;
}

/** Writes `src/sinter.components.d.ts` when it changed; its path, or null when no component has a script. */
export function writeComponentTypes(root: string, read?: (file: string) => string): string | null {
  const text = componentTypes(root, read);
  const file = join(root, 'src', 'sinter.components.d.ts');
  if (text === null) return null;
  let current = '';
  try { current = readFileSync(file, 'utf8'); } catch { /* missing */ }
  if (current !== text) { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, text); }
  return file;
}
