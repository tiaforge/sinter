// What the language server knows: the projects under the editor's folders, their
// pages and partials, open buffers, and the diagnostics of each file. Independent of
// LSP itself, so tests drive it directly.
import { existsSync, readFileSync } from 'node:fs';
import { basename, dirname, join, resolve, sep } from 'node:path';
import type { CheckUnit } from '../compiler/check-unit.js';
import { compile, type Diagnostic, type HelperManifest } from '../compiler/index.js';
import { project, viteProject, type Project, type ProjectOptions } from '../project.js';

const VITE_CONFIGS = ['vite.config.ts', 'vite.config.js', 'vite.config.mts', 'vite.config.mjs', 'vite.config.cts', 'vite.config.cjs'];

export interface ProjectState {
  root: string;
  options: ProjectOptions;
  project: Project;
  /** HTML entries from the Vite config */
  entries: Set<string>;
  /** every page compiled so far (entries, plus open HTML files no page includes) */
  pages: Set<string>;
  /** per page: the files it includes */
  includes: Map<string, string[]>;
  /** per page: its last compile's diagnostics */
  diagnostics: Map<string, Diagnostic[]>;
  /** per page: its last compile's check unit */
  units: Map<string, CheckUnit>;
  /** TypeScript's diagnostics, per page (or per check run); they lag behind compiles */
  types: Map<string, Diagnostic[]>;
  /** files whose change reloads the project: Vite config, helpers, types, specs */
  inputs: Set<string>;
}

export interface WorkspaceHooks {
  /** the diagnostics of `file` changed (an empty list clears them) */
  publish(file: string, diagnostics: Diagnostic[]): void;
  /** pages were compiled; their check units are in `state.units` */
  compiled?(state: ProjectState, pages: string[]): void;
}

/** The component a file is (`src/components/<name>.html`), or null. */
function componentName(root: string, file: string): string | null {
  const dir = join(root, 'src', 'components') + sep;
  if (!file.startsWith(dir) || file.slice(dir.length).includes(sep)) return null;
  const name = basename(file).replace(/\.html$/, '');
  return /^[a-z][a-z0-9]*(-[a-z0-9]+)+$/.test(name) ? name : null;
}

export class Workspace {
  /** open buffers by absolute path */
  readonly docs = new Map<string, string>();
  readonly projects = new Map<string, Promise<ProjectState>>();
  /** files that currently have diagnostics published */
  private published = new Set<string>();

  constructor(private hooks: WorkspaceHooks) {}

  /** The project a file belongs to: the nearest folder with a Vite config, else with a package.json. */
  rootOf(file: string): string {
    let pkg: string | null = null;
    for (let dir = dirname(file); ; dir = dirname(dir)) {
      if (VITE_CONFIGS.some((c) => existsSync(join(dir, c)))) return dir;
      if (!pkg && existsSync(join(dir, 'package.json'))) pkg = dir;
      if (dirname(dir) === dir) return pkg ?? dirname(file);
    }
  }

  projectFor(file: string): Promise<ProjectState> {
    const root = this.rootOf(file);
    let p = this.projects.get(root);
    if (!p) {
      p = this.load(root);
      this.projects.set(root, p);
    }
    return p;
  }

  private async load(root: string): Promise<ProjectState> {
    let pages: string[] = [];
    let options: ProjectOptions = {};
    try {
      ({ pages, options } = await viteProject(root));
    } catch (e) {
      process.stderr.write(`sinter lsp: reading the Vite config in ${root} failed: ${(e as Error).message}\n`);
    }
    const p = project(root, options);
    const inputs = new Set<string>(VITE_CONFIGS.map((c) => join(root, c)));
    for (const f of [p.helpersFile, p.actionsFile, p.types, ...p.openapi.map((s) => s.file)]) if (f) inputs.add(f);
    for (const spec of options.openapi == null ? [] : ([] as string[]).concat(options.openapi)) inputs.add(resolve(root, spec));
    for (const ext of ['.js', '.ts']) {
      inputs.add(join(root, 'src/sinter.helpers' + ext));
      inputs.add(join(root, 'src/sinter.actions' + ext));
      inputs.add(join(root, 'src/sinter.types' + ext));
    }
    inputs.add(join(root, 'src/sinter.types.d.ts'));
    for (const m of Object.values(p.helpers.namespaces)) if (m.module.startsWith('/')) inputs.add(join(root, m.module));
    const state: ProjectState = {
      root, options, project: p, entries: new Set(pages), pages: new Set(pages),
      includes: new Map(), diagnostics: new Map(), units: new Map(), types: new Map(), inputs,
    };
    for (const [file] of this.docs) if (file.endsWith('.html') && this.rootOf(file) === root) state.pages.add(file);
    this.compilePages(state, [...state.pages]);
    return state;
  }

  async open(file: string, text: string): Promise<void> {
    this.docs.set(file, text);
    if (file.endsWith('.html')) await this.htmlChanged(file);
    else await this.otherChanged(file);
  }

  async change(file: string, text: string): Promise<void> {
    this.docs.set(file, text);
    if (file.endsWith('.html')) await this.htmlChanged(file);
  }

  async close(file: string): Promise<void> {
    this.docs.delete(file);
    if (!file.endsWith('.html')) return;
    const state = await this.projectFor(file);
    // a page that is neither an entry nor open is forgotten; its diagnostics go with it
    if (!state.entries.has(file) && state.pages.has(file)) {
      state.pages.delete(file);
      state.includes.delete(file);
      state.diagnostics.delete(file);
      state.units.delete(file);
      state.types.delete(file);
      this.publishAll(state);
      return;
    }
    await this.htmlChanged(file);
  }

  /** A file changed on disk (saved, or changed by another program). */
  async fileChanged(file: string): Promise<void> {
    if (file.endsWith('.html')) {
      if (!this.docs.has(file)) await this.htmlChanged(file);
      return;
    }
    await this.otherChanged(file);
  }

  /** a non-HTML file: reload projects that read it */
  private async otherChanged(file: string): Promise<void> {
    for (const [root, p] of this.projects) {
      const state = await p;
      if (!state.inputs.has(file)) continue;
      const next = this.load(root);
      this.projects.set(root, next);
      const fresh = await next;
      // pages the old state knew but the new one doesn't lose their diagnostics
      for (const page of state.pages) if (!fresh.pages.has(page)) state.diagnostics.delete(page);
      this.publishAll(fresh);
    }
  }

  private async htmlChanged(file: string): Promise<void> {
    const state = await this.projectFor(file);
    const includers = [...state.includes].filter(([, files]) => files.includes(file)).map(([page]) => page);
    const pages = new Set(includers);
    if (state.pages.has(file) || !includers.length) {
      if (this.docs.has(file) || existsSync(file)) {
        state.pages.add(file);
        pages.add(file);
      }
    }
    this.compilePages(state, [...pages]);
  }

  /** the text of a file: the open buffer, else the disk */
  read(file: string): string {
    return this.docs.get(file) ?? readFileSync(file, 'utf8');
  }

  private compilePages(state: ProjectState, pages: string[]): void {
    const p = state.project;
    const readFile = (path: string): string => {
      const disk = p.readFile(path); // refuses files outside the root
      return this.docs.get(resolve(path)) ?? disk;
    };
    for (const page of pages) {
      let html: string;
      try { html = this.read(page); } catch { continue; }
      // a page that is now included by another one is a partial, not a page
      if (!state.entries.has(page) && [...state.includes].some(([other, files]) => other !== page && files.includes(page))) {
        state.pages.delete(page);
        state.diagnostics.delete(page);
        state.includes.delete(page);
        state.units.delete(page);
        state.types.delete(page);
        continue;
      }
      // a component no page uses: compiled through a use of its own, which reports what is wrong inside it
      const component = componentName(state.root, page);
      if (component) {
        html = `<${component}></${component}>`;
      }
      try {
        const out = compile(html, {
          file: component ? join(state.root, `.sinter-use-${component}.html`) : page, root: state.root, dev: false, helpers: p.helpers, actions: p.actions, config: p.config, readFile, check: true, openapi: p.openapi, complexity: p.complexity, checkCycles: p.checkCycles,
        });
        state.includes.set(page, out.files.map((f) => resolve(f)).filter((f) => f !== page));
        // the use is not in any file, nor are the props it leaves out
        state.diagnostics.set(page, component ? out.diagnostics.filter((d) => resolve(d.file) !== resolve(state.root, `.sinter-use-${component}.html`)) : out.diagnostics);
        if (out.check) state.units.set(page, out.check);
      } catch (e) {
        state.diagnostics.set(page, [{ severity: 'error', code: 'SN401', message: `sinter could not compile this page: ${(e as Error).message}`, file: page, line: 1, col: 1 }]);
      }
    }
    this.publishAll(state);
    this.hooks.compiled?.(state, pages.filter((x) => state.pages.has(x)));
  }

  /**
   * The compiler's errors in `file` if it read `text` and the modules exported what `helpers` and
   * `actions` say, for every page that compiles it (the file itself, or the pages including it).
   * Nothing is stored or published.
   */
  trial(state: ProjectState, file: string, text: string, helpers: HelperManifest, actions: HelperManifest): Diagnostic[] {
    const p = state.project;
    const readFile = (path: string): string => {
      if (resolve(path) === file) return text;
      const disk = p.readFile(path); // refuses files outside the root
      return this.docs.get(resolve(path)) ?? disk;
    };
    const pages = state.pages.has(file) ? [file] : [...state.includes].filter(([, files]) => files.includes(file)).map(([page]) => page);
    const out: Diagnostic[] = [];
    for (const page of pages) {
      let html: string;
      try { html = page === file ? text : this.read(page); } catch { continue; }
      try {
        const r = compile(html, { file: page, root: state.root, dev: false, helpers, actions, config: p.config, readFile, check: true, openapi: p.openapi });
        out.push(...r.diagnostics.filter((d) => d.severity === 'error' && d.file === file));
      } catch (e) {
        out.push({ severity: 'error', code: 'SN401', message: (e as Error).message, file, line: 1, col: 1 });
      }
    }
    return out;
  }

  /** Sets TypeScript's diagnostics under `key` (a page) and publishes. Ignored for a replaced project state. */
  async setTypes(state: ProjectState, key: string, list: Diagnostic[]): Promise<void> {
    if ((await this.projects.get(state.root)) !== state) return;
    state.types.set(key, list);
    this.publishAll(state);
  }

  /** Publishes every file's diagnostics, merged across the pages that include it. */
  private publishAll(state: ProjectState): void {
    const byFile = new Map<string, Diagnostic[]>();
    const seen = new Set<string>();
    const add = (d: Diagnostic) => {
      const key = `${d.file}\0${d.line}\0${d.col}\0${d.code}\0${d.message}`;
      if (seen.has(key)) return;
      seen.add(key);
      const list = byFile.get(d.file) ?? [];
      list.push(d);
      byFile.set(d.file, list);
    };
    for (const d of state.project.diagnostics) add(d);
    for (const page of state.pages) for (const d of state.diagnostics.get(page) ?? []) add(d);
    for (const list of state.types.values()) for (const d of list) add(d);
    // files of this project that had diagnostics and now have none
    for (const file of this.published) {
      if (byFile.has(file) || this.rootOf(file) !== state.root) continue;
      this.published.delete(file);
      this.hooks.publish(file, []);
    }
    for (const [file, list] of byFile) {
      this.published.add(file);
      this.hooks.publish(file, list);
    }
    // open files without problems get an empty list, so editors show them as checked
    for (const file of this.docs.keys()) if (!byFile.has(file) && this.rootOf(file) === state.root) this.hooks.publish(file, []);
  }
}
