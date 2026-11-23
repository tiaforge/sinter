// Where a component's files are, in a components folder (`src/components/`, a library's `components/` and
// `components/internal/`): its HTML is `<tag>.html` in the folder, or `<tag>/<tag>.html` in a folder of its own
// with the files that go with it (its script, its early renderer, modules and tests of its own). Every part of
// sinter that looks for a component's files asks this module, so the two places are one rule.
import { type Dirent, existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import type { Diagnostic } from './compiler/diagnostics.js';
import { COMPONENT_NAME, componentOfPath, componentPaths, inlineScriptHtml, inlineScriptModule } from './compiler/components.js';
import type { SourceMap } from './compiler/sourcemap.js';

export { componentOfPath, componentPaths };

/** The HTML file of a component in a components folder, or null: `<dir>/<tag>.html`, else `<dir>/<tag>/<tag>.html`. */
export function componentHtml(dir: string, tag: string): string | null {
  for (const p of componentPaths(tag)) { const f = join(dir, ...p.split('/')); if (existsSync(f)) return f; }
  return null;
}

/** The component an HTML file is in one of the components folders (`<tag>.html` or `<tag>/<tag>.html`), or null. */
export function componentOfFile(dirs: readonly string[], file: string): string | null {
  for (const d of dirs) {
    const rel = relative(d, file);
    if (!rel || rel.startsWith('..')) continue;
    const name = componentOfPath(rel.split(sep).join('/'));
    if (name) return name;
  }
  return null;
}

export interface ComponentsFound {
  /** the components' names, sorted */
  names: string[];
  /** each component's HTML file */
  files: Map<string, string>;
  /** HTML files where no component can be (SN349): a component in both places, a stray file in a component's folder */
  problems: Diagnostic[];
}

/**
 * The components of a folder: `<tag>.html`, and `<tag>/<tag>.html` in a folder named after the component. `skip`:
 * folders that are not components' (a library's `internal/`). A folder of modules (no HTML) is no component and no
 * problem; HTML anywhere else in it, at any depth, is SN349, so a file never silently stops being a component.
 * `node_modules` and dot-folders are not looked in.
 */
export function findComponents(dir: string, skip: readonly string[] = []): ComponentsFound {
  const files = new Map<string, string>();
  const problems: Diagnostic[] = [];
  const problem = (file: string, message: string, hint: string) => problems.push({ severity: 'error', code: 'SN349', message, file, line: 1, col: 1, hint });
  const looked = (e: Dirent) => e.isDirectory() && e.name !== 'node_modules' && !e.name.startsWith('.');
  const htmlOf = (ds: Dirent[]) => ds.filter((f) => f.isFile() && f.name.endsWith('.html')).map((f) => f.name).sort();
  // Folders below a component's folder or a folder of modules: no HTML there is a component's, as component tags are
  // one namespace (`forms/text-input/text-input.html` is no `<text-input>`, nor `<forms-text-input>`).
  const deeper = (d: string, rel: string, ds: Dirent[]): void => {
    for (const x of ds.filter(looked).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const xd = join(d, x.name), xr = `${rel}/${x.name}`;
      let xs: Dirent[] = [];
      try { xs = readdirSync(xd, { withFileTypes: true }); } catch { continue; }
      for (const f of htmlOf(xs)) {
        const name = f.slice(0, -5);
        if (name === x.name && COMPONENT_NAME.test(name)) problem(join(xd, f), `\`${xr}/${f}\` is not a component: a component's folder is directly in the components folder, as component tags are one namespace and folders do not group them`, `move it to \`${name}/${name}.html\``);
        else problem(join(xd, f), `\`${xr}/${f}\` is not a component: a component's HTML is \`<name>.html\` or \`<name>/<name>.html\` in the components folder`, COMPONENT_NAME.test(name) ? `move it to \`${name}.html\` or \`${name}/${name}.html\` in the components folder` : 'a component\'s name has a `-` (`task-ring`); move other HTML out of the components folder');
      }
      deeper(xd, xr, xs);
    }
  };
  let entries: Dirent[] = [];
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return { names: [], files, problems }; }
  for (const e of entries) if (e.isFile() && e.name.endsWith('.html') && COMPONENT_NAME.test(e.name.slice(0, -5))) files.set(e.name.slice(0, -5), join(dir, e.name));
  for (const e of entries) {
    if (!looked(e) || skip.includes(e.name)) continue;
    const sub = join(dir, e.name);
    let inner: Dirent[] = [];
    try { inner = readdirSync(sub, { withFileTypes: true }); } catch { continue; }
    const html = htmlOf(inner);
    const own = COMPONENT_NAME.test(e.name) && html.includes(`${e.name}.html`);
    if (own) {
      if (files.has(e.name)) problem(join(sub, `${e.name}.html`), `\`<${e.name}>\` is both \`${e.name}.html\` and \`${e.name}/${e.name}.html\`: a component's HTML is in one place`, `keep one: move the files of \`${e.name}.html\` into \`${e.name}/\`, or out of it`);
      else files.set(e.name, join(sub, `${e.name}.html`));
    }
    for (const f of html) {
      if (own && f === `${e.name}.html`) continue;
      const name = f.slice(0, -5);
      problem(join(sub, f), own
        ? `\`${e.name}/${f}\` is not a component: in a component's folder, only \`${e.name}.html\` is its HTML`
        : `\`${e.name}/${f}\` is not a component: a component in a folder of its own is \`<name>/<name>.html\`, and folders do not group components`,
      COMPONENT_NAME.test(name) ? `move it to \`${name}.html\` or \`${name}/${name}.html\` beside \`${e.name}${own ? '/' : ''}\`` : 'a component\'s name has a `-` (`task-ring`); move other HTML out of the components folder');
    }
    deeper(sub, e.name, inner);
  }
  return { names: [...files.keys()].sort(), files, problems };
}

/**
 * The module of a component's top-level `<script>` (`…/task-ring.html.script.ts`), from its HTML file: its code (at the
 * same lines and columns as in the file) and a map to the file. Null when the path names none, or a file of that
 * name exists (it is the app's own module then).
 */
export function inlineScriptSource(path: string, read: (f: string) => string = (f) => readFileSync(f, 'utf8')): { code: string; map: SourceMap; html: string } | null {
  const html = inlineScriptHtml(path);
  if (!html || existsSync(path)) return null;
  let text: string;
  try { text = read(html); } catch { return null; }
  const m = inlineScriptModule(text, html);
  return m ? { ...m, html } : null;
}

/** A module's source: a file's text, or a component's top-level `<script>` for its module path. */
export function readModuleSource(path: string): string {
  return inlineScriptSource(path)?.code ?? readFileSync(path, 'utf8');
}
