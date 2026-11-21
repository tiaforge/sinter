// What the language server knows: the projects under the editor's folders, their
// pages and partials, open buffers, and the diagnostics of each file. Independent of
// LSP itself, so tests drive it directly.
import { existsSync, readFileSync, statSync } from 'node:fs';
import { basename, dirname, join, resolve, sep } from 'node:path';
import type { CheckUnit } from '../compiler/check-unit.js';
import { compile, type Diagnostic, type HelperManifest } from '../compiler/index.js';
import { compileOptionsOf, modulesDir, project, VITE_CONFIGS, viteProject, type Project, type ProjectOptions } from '../project.js';
import { loadHelpers, unloadedDiagnostic, type NodeHelpers } from '../helpers-node.js';
import { FoldCache } from '../fold-check.js';
import { writeComponentTypes } from '../components-build.js';
import { componentKinds } from '../compiler/head.js';
import { checkLocale } from '../locales-build.js';
import { snapshotOptions } from '../content-node.js';


export interface ProjectState {
  root: string;
  options: ProjectOptions;
  /** with `localePrefix`, the base language, which pages are checked in (as `sinter check` does) */
  locale: { name: string; urls: null; base: string } | null;
  project: Project;
  /** HTML entries from the Vite config */
  entries: Set<string>;
  /** every page compiled so far (entries, plus open HTML files no page includes) */
  pages: Set<string>;
  /** per page: the files it includes */
  includes: Map<string, string[]>;
  /** per page: the folders its `file:` globs list, and what their files match (an added or removed file recompiles it) */
  globs: Map<string, Array<{ dir: string; match: RegExp }>>;
  /** files read for `file:` sources, by modification time, and folders listed for globs (until a file event) */
  reads: Map<string, { mtimeMs: number; text: string }>;
  listings: Map<string, string[]>;
  /** per page: its last compile's diagnostics */
  diagnostics: Map<string, Diagnostic[]>;
  /** per page: its last compile's check unit */
  units: Map<string, CheckUnit>;
  /** TypeScript's diagnostics, per page (or per check run); they lag behind compiles */
  types: Map<string, Diagnostic[]>;
  /** files whose change reloads the project: Vite config, helpers (and what the helpers module reaches), types, specs */
  inputs: Set<string>;
  /** the helpers module as loaded in Node, with what of it may fold (helpers-node.ts); loaded again with the project */
  helpers: NodeHelpers;
}

export interface WorkspaceHooks {
  /** the diagnostics of `file` changed (an empty list clears them) */
  publish(file: string, diagnostics: Diagnostic[]): void;
  /** pages were compiled; their check units are in `state.units` */
  compiled?(state: ProjectState, pages: string[]): void;
}

/** The component a file is (`src/components/<name>.html`), or null. */
function componentName(root: string, file: string, dir = 'components'): string | null {
  const d = join(root, 'src', dir) + sep;
  if (!file.startsWith(d) || file.slice(d.length).includes(sep)) return null;
  const name = basename(file).replace(/\.html$/, '');
  return /^[a-z][a-z0-9]*(-[a-z0-9]+)+$/.test(name) ? name : null;
}

export class Workspace {
  /** open buffers by absolute path */
  readonly docs = new Map<string, string>();
  readonly projects = new Map<string, Promise<ProjectState>>();
  /** files that currently have diagnostics published */
  private published = new Set<string>();
  /** the static check's per-module analyses (fold-check.ts), kept across reloads: a module is read again only when it changed */
  private readonly foldCache = new FoldCache();

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
    const at = modulesDir(root);
    for (const ext of ['.js', '.ts']) {
      inputs.add(join(root, `${at}/sinter.helpers${ext}`));
      inputs.add(join(root, `${at}/sinter.actions${ext}`));
      inputs.add(join(root, `${at}/sinter.types${ext}`));
      // the config module (`changesRequests`, its URL in each page), the early module, the content module (its collections)
      for (const m of ['sinter.config', 'sinter.early', 'sinter.content']) inputs.add(join(root, `${at}/${m}${ext}`));
    }
    inputs.add(join(root, `${at}/sinter.types.d.ts`));
    for (const m of Object.values(p.helpers.namespaces)) if (m.module.startsWith('/')) inputs.add(join(root, m.module));
    // the helpers module in Node, as the build loads it (with the app's Vite config); the files it reaches reload the project
    const helpers = await loadHelpers({ root, helpersFile: p.helpersFile, manifest: p.helpers, cache: this.foldCache });
    for (const f of helpers.files) inputs.add(f);
    const unloaded = unloadedDiagnostic(root, p.helpersFile, helpers);
    if (unloaded) p.diagnostics.push(unloaded);
    let locale: ProjectState['locale'] = null;
    try { locale = checkLocale(root, options as ProjectOptions & { localePrefix?: boolean }); } catch (e) {
      process.stderr.write(`sinter lsp: ${(e as Error).message}\n`);
    }
    const state: ProjectState = {
      root, options, locale, project: p, entries: new Set(pages), pages: new Set(pages),
      includes: new Map(), globs: new Map(), reads: new Map(), listings: new Map(), diagnostics: new Map(), units: new Map(), types: new Map(), inputs, helpers,
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

  /** a non-HTML file: reload projects that read it (their config, helpers, types), else recompile the pages that read it */
  private async otherChanged(file: string): Promise<void> {
    for (const [root, p] of this.projects) {
      const state = await p;
      if (!state.inputs.has(file)) {
        // a `file:` source: the pages that read it, and the pages whose glob it matches (it may be new, or gone)
        state.listings.clear();
        state.reads.delete(file);
        const f = file.split(sep).join('/');
        const pages = new Set([...state.includes].filter(([, files]) => files.includes(file)).map(([page]) => page));
        for (const [page, globs] of state.globs) if (globs.some((g) => f.startsWith(g.dir + '/') && g.match.test(f.slice(g.dir.length + 1)))) pages.add(page);
        if (pages.size) this.compilePages(state, [...pages]);
        continue;
      }
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
    // a component's contract changed: its script's types follow, without the dev server
    if (componentName(state.root, file) || componentName(state.root, file, 'layouts')) {
      try { writeComponentTypes(state.root, (f) => this.docs.get(resolve(f)) ?? readFileSync(f, 'utf8'), state.project.libraries); } catch { /* reported by the compiler */ }
    }
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

  /** what the build's snapshot gives a compile (the editor runs no loaders): the collections, the content namespaces with the helpers, the content module */
  private snapshotOf(state: ProjectState) {
    return snapshotOptions(state.root, state.project.contentFile, state.project.helpers);
  }

  /** the project's listing of a folder for `file:` globs, kept until a file event (`otherChanged`) */
  private lister(state: ProjectState): (dir: string) => string[] {
    return (dir) => {
      let l = state.listings.get(dir);
      if (!l) { l = state.project.listFiles(dir); state.listings.set(dir, l); }
      return l;
    };
  }

  private compilePages(state: ProjectState, pages: string[]): void {
    const p = state.project;
    const readFile = (path: string): string => {
      const open = this.docs.get(resolve(path));
      // a file read before and unchanged on disk: kept (a glob's thousand posts are not read again at each keystroke)
      let mtimeMs = -1;
      try { mtimeMs = statSync(path).mtimeMs; } catch { /* missing: p.readFile reports it */ }
      const kept = state.reads.get(path);
      if (open === undefined && kept && kept.mtimeMs === mtimeMs) return kept.text;
      const disk = p.readFile(path); // refuses files outside the root
      if (mtimeMs >= 0 && !path.endsWith('.html')) state.reads.set(path, { mtimeMs, text: disk });
      return open ?? disk;
    };
    const { helpers, content } = this.snapshotOf(state);
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
      // a component or layout no page uses: compiled through a use of its own, which reports what is wrong inside it
      const component = componentName(state.root, page) ?? componentName(state.root, page, 'layouts');
      if (component) {
        const kinds = componentKinds((t) => { try { return t === component ? html : readFileSync(join(state.root, 'src/components', `${t}.html`), 'utf8'); } catch { return null; } });
        html = kinds(component) === 'head' ? `<!doctype html><html><head><${component}></${component}></head><body></body></html>` : `<${component}></${component}>`;
      }
      try {
        const out = compile(html, {
          // (helper modules that reach a lazy package: their helpers outside a let are SN324, as in the build)
          ...compileOptionsOf(p, component ? undefined : page), ...(p.swap ? { swap: true } : {}),
          helperValues: state.helpers.module, helperFold: state.helpers.fold,
          file: component ? join(state.root, `.sinter-use-${component}.html`) : page, dev: false, helpers, readFile, listFiles: this.lister(state), ...(state.locale ? { locale: state.locale } : {}), ...content, check: true,
        });
        state.includes.set(page, out.files.map((f) => resolve(f)).filter((f) => f !== page));
        if (out.globs?.length) state.globs.set(page, out.globs.map((g) => ({ dir: g.dir.replace(/\/$/, ''), match: new RegExp(g.match) }))); else state.globs.delete(page);
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
    const out: Diagnostic[] = [], { content } = this.snapshotOf(state);
    for (const page of pages) {
      let html: string;
      try { html = page === file ? text : this.read(page); } catch { continue; }
      try {
        // as the page compiles (compilePages), with the helpers and actions the fix would declare
        const r = compile(html, { ...compileOptionsOf(p, page), helpers, actions, file: page, dev: false, readFile, listFiles: this.lister(state), ...(state.locale ? { locale: state.locale } : {}), ...content, check: true });
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
