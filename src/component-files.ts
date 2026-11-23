// Where a component's files are, in a components folder (`src/components/`, a library's `components/` and
// `components/internal/`): its HTML is `<tag>.html` in the folder, or `<tag>/<tag>.html` in a folder of its own
// with the files that go with it (its script, its early renderer, modules and tests of its own). Every part of
// sinter that looks for a component's files asks this module, so the two places are one rule.
import { existsSync, readdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import type { Diagnostic } from './compiler/diagnostics.js';
import { COMPONENT_NAME, componentOfPath, componentPaths } from './compiler/components.js';

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
 * problem; HTML anywhere else in it is SN349, so a file never silently stops being a component.
 */
export function findComponents(dir: string, skip: readonly string[] = []): ComponentsFound {
  const files = new Map<string, string>();
  const problems: Diagnostic[] = [];
  const problem = (file: string, message: string, hint: string) => problems.push({ severity: 'error', code: 'SN349', message, file, line: 1, col: 1, hint });
  let entries: import('node:fs').Dirent[] = [];
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return { names: [], files, problems }; }
  for (const e of entries) if (e.isFile() && e.name.endsWith('.html') && COMPONENT_NAME.test(e.name.slice(0, -5))) files.set(e.name.slice(0, -5), join(dir, e.name));
  for (const e of entries) {
    if (!e.isDirectory() || skip.includes(e.name) || e.name === 'node_modules' || e.name.startsWith('.')) continue;
    const sub = join(dir, e.name);
    let html: string[] = [];
    try { html = readdirSync(sub).filter((f) => f.endsWith('.html')).sort(); } catch { continue; }
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
  }
  return { names: [...files.keys()].sort(), files, problems };
}
