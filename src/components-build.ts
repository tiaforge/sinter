// Components with a script, at build time: the generated base class a script extends
// (`import { TaskRingComponent } from './task-ring.html'`, served by the Vite plugin) and its
// types, `src/sinter.components.d.ts`.
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import * as parse5 from 'parse5';
import { parseExpressionAt } from 'acorn';
import type { DefaultTreeAdapterMap } from 'parse5';
import { COMPONENT_NAME, withoutSlots } from './compiler/components.js';
import { componentKinds, declaringTemplate } from './compiler/head.js';
import { typeExports } from './check/index.js';
import { modulesDir, type Library } from './libraries.js';

type El = DefaultTreeAdapterMap['element'];
type Parent = DefaultTreeAdapterMap['parentNode'];

/** the module the generated base classes extend `Component` from: the components feature, which compiled pages import too */
export const COMPONENTS_MODULE = '@tiaforge-ui/sinter/runtime/components';
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
  const template = declaringTemplate(frag.childNodes);
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
      if (c.tagName === 'template') walk((c as DefaultTreeAdapterMap['template']).content ?? c, cond || attr(c, 'data-sn-for') !== undefined || attr(c, 'data-sn-if') !== undefined || attr(c, 'data-sn-else') !== undefined);
    }
  };
  if (root) walk({ childNodes: [root] } as unknown as Parent, false);
  // a slot that passes data (`Slot<T>`) is filled with markup: not in `this.props`
  const props = withoutSlots((attr(template, 'data-sn-props') ?? attr(template, 'data-sn-component') ?? '').trim() || '{}');
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
 * `data-sn-props`, `this.emit()` from `data-sn-emits`, `this.refs` from `data-sn-ref` (by tag),
 * `this.state` from the root's `data-sn-state`. Null when no component has a script.
 */
export function componentTypes(root: string, read: (file: string) => string = (f) => readFileSync(f, 'utf8'), libs: readonly Library[] = []): string | null {
  const dir = join(root, 'src', 'components');
  let files: string[] = [];
  try { files = readdirSync(dir).filter((f) => f.endsWith('.html') && COMPONENT_NAME.test(f.slice(0, -5))).sort(); } catch { if (!libs.length) return null; }
  // a library that is the project itself (its own repository, `sinter check` over its fixtures): its d.ts is in its folder
  const self = libs.find((l) => l.dir === root);
  const out: string[] = [];
  const src = self ? self.folder : join(root, 'src');
  const typesFile = ['sinter.types.ts', 'sinter.types.d.ts'].map((f) => join(root, modulesDir(root), f)).find((f) => existsSync(f));
  const specOf = (f: string) => { const s = relative(src, f).split(sep).join('/').replace(/\.(d\.)?ts$/, ''); return s.startsWith('.') ? s : './' + s; };
  /** the declarations of one folder's components with a script, type names resolved against `types` */
  const declare = (cdir: string, list: string[], types: string | null, shown: string) => {
    const typeNames = types ? typeExports(readFileSync(types, 'utf8')) : [];
    const typesSpec = types ? specOf(types) : null;
    for (const f of list) {
      const name = f.slice(0, -5);
      if (!componentScript(join(cdir, f))) continue;
      let c: Contract | null = null;
      try { c = contractOf(read(join(cdir, f))); } catch { /* reported by the compiler */ }
      if (!c) continue;
      const text = [c.props, c.emits].join(' ');
      const used = typeNames.filter((n) => new RegExp(`(?<![\\w$.])${n.replace(/\$/g, '\\$')}(?![\\w$])`).test(text));
      out.push(`declare module '*/${name}.html' {`);
      for (const n of used) out.push(`  type ${n} = import('${typesSpec}').${n};`);
      out.push(`  const Base: typeof import('${COMPONENTS_MODULE}').Component;`);
      out.push(`  /** the base of \`${shown}${name}.ts\`: props, events, refs and state as \`${f}\` declares them */`);
      out.push(`  export class ${pascal(name)}Component extends Base<${c.props}, ${c.emits}, ${c.refs}, ${c.state}> {}`);
      out.push('}');
    }
  };
  if (!self) declare(dir, files, typesFile ?? null, 'src/components/');
  // the libraries' components, public and internal, typed by each library's types module
  const libFiles = (l: Library, internal: boolean) => (internal ? l.internal : l.public).map((n) => `${n}.html`);
  for (const l of libs) {
    declare(join(l.folder, 'components'), libFiles(l, false), l.types, `${l.name}/${relative(l.dir, l.folder).split(sep).join('/')}/components/`);
    declare(join(l.folder, 'components', 'internal'), libFiles(l, true), l.types, `${l.name}/${relative(l.dir, l.folder).split(sep).join('/')}/components/internal/`);
  }
  const typeNames = typesFile ? typeExports(readFileSync(typesFile, 'utf8')) : [];
  const typesSpec = typesFile ? specOf(typesFile) : null;
  // the layouts and their props (`src/layouts/<name>.html`, `<html data-sn-props>`)
  let layouts: string[] = [];
  if (!self) try { layouts = readdirSync(join(root, 'src', 'layouts')).filter((f) => f.endsWith('.html') && COMPONENT_NAME.test(f.slice(0, -5))).sort(); } catch { /* none */ }
  const libNames = libs.flatMap((l) => l.public);
  if (!files.length && !layouts.length && !libNames.length) return null;
  // every component's name: what `<sn-component use>` takes, and a helper that picks one returns (head components are not chosen)
  // a component's kind as the compiler decides it, the components it uses counted by theirs
  const kinds = componentKinds((t) => { for (const d of [dir, ...libs.map((l) => join(l.folder, 'components'))]) { try { return read(join(d, `${t}.html`)); } catch { /* not here */ } } return null; });
  const body = (self ? [] : files).filter((f) => kinds(f.slice(0, -5)) !== 'head').map((f) => f.slice(0, -5));
  const libBody = libs.flatMap((l) => l.public.filter((n) => kinds(n) !== 'head'));
  const names = [...body, ...libBody].sort().map((n) => JSON.stringify(n)).join(' | ') || 'never';
  const from = [...(self ? [] : ['src/components/*.html']), ...(layouts.length ? ['src/layouts/*.html'] : []), ...libs.map((l) => `${l.name}'s components`)];
  const lines = [`// Generated by sinter from ${from.join(', ').replace(/, ([^,]*)$/, ' and $1')}. Do not edit.`, `/** every component of the app${libs.length ? ' and the public ones of its libraries' : ''}, by its tag */`, `type ComponentName = ${names};`,
    '/** a slot that passes T to its fill, as a member of a component\'s props type: `cell: Slot<{ row: Row }>` */', 'interface Slot<T> { readonly \'sinter.slot\': T }'];
  if (layouts.length) {
    lines.push('/** every layout of the app, by its tag */', `type LayoutName = ${layouts.map((f) => JSON.stringify(f.slice(0, -5))).join(' | ')};`);
    const props: string[] = [];
    for (const f of layouts) {
      let text = '';
      try { text = read(join(root, 'src', 'layouts', f)); } catch { continue; }
      // a whole document without `data-sn-props` takes no props
      const m = /<html\b[^>]*\sdata-sn-(?:props|layout)\s*=\s*"([^"]*)"/i.exec(text) ?? (/<html\b/i.test(text) ? [text, '{}'] : null);
      if (!m) continue;
      const used = typeNames.filter((n) => new RegExp(`(?<![\\w$.])${n.replace(/\$/g, '\\$')}(?![\\w$])`).test(m[1]!));
      const t = (m[1]!.trim() || '{}').replace(/&quot;/g, '"').replace(/&amp;/g, '&');
      props.push(`  ${JSON.stringify(f.slice(0, -5))}: ${used.length ? used.reduce((x, n) => x.replace(new RegExp(`(?<![\\w$.])${n}(?![\\w$])`, 'g'), `import('${typesSpec}').${n}`), t) : t};`);
    }
    lines.push('/** the props each layout declares (`data-sn-props` on its `<html>`) */', `interface LayoutProps {\n${props.join('\n')}\n}`);
  }
  return `${lines.join('\n')}\n${out.join('\n')}${out.length ? '\n' : ''}`;
}

/** Writes `src/sinter.components.d.ts` when it changed; its path, or null when no component has a script. */
export function writeComponentTypes(root: string, read?: (file: string) => string, libs: readonly Library[] = []): string | null {
  const text = componentTypes(root, read, libs);
  const self = libs.find((l) => l.dir === root);
  const file = self ? join(self.folder, 'sinter.components.d.ts') : join(root, 'src', 'sinter.components.d.ts');
  if (text === null) return null;
  let current = '';
  try { current = readFileSync(file, 'utf8'); } catch { /* missing */ }
  if (current !== text) { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, text); }
  return file;
}
