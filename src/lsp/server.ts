// `sinter lsp`: a language server for sinter pages over stdio. It compiles open
// buffers as they change and publishes the compiler's diagnostics; TypeScript's
// follow once typing pauses (`typescript.ts`), and hovers come from TypeScript.
import type { Readable, Writable } from 'node:stream';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { CODES, docsUrl, type Diagnostic } from '../compiler/index.js';
import { check, findTsc, typeExports } from '../check/index.js';
import { Connection } from './rpc.js';
import { existsSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { HEAD_DECL } from '../components-build.js';
import { offsetOf, slotCompletions, slotDefinition, tagCompletions, tagHover, type TagFile } from './markup.js';
import { didYouMeanEdit } from './quickfix.js';
import { pathCompletions, pathDefinition, pathFix, pathHover } from './paths.js';
import { editFor, fixPlans, plans, type ExtractContext, type Plan } from './extract.js';
import { TypeScriptBridge, typescriptMajor, type Target } from './typescript.js';
import { Workspace, type ProjectState } from './workspace.js';

/** How long typing must pause before TypeScript checks the pages. */
export const TYPECHECK_DELAY = 300;

/**
 * Diagnostic codes (`SN…`) whose quick fixes include "Extract to helper" for the expression they
 * are about (`fixPlans` in `extract.ts`): `SN507`, an expression too complex for markup.
 */
export const EXTRACT_FIX_CODES = new Set<string>(['SN507']);

export interface Position { line: number; character: number }
export interface Range { start: Position; end: Position }

export interface LspDiagnostic {
  range: Range;
  severity: 1 | 2;
  code: string;
  codeDescription: { href: string };
  source: 'sinter';
  message: string;
}

/** The range a diagnostic underlines: the name or word at its position, else one character. */
export function rangeOf(text: string, line: number, col: number): Range {
  const lines = text.split('\n');
  const l = Math.max(0, Math.min(line - 1, lines.length - 1));
  const s = lines[l] ?? '';
  const c = Math.max(0, Math.min(col - 1, s.length));
  const m = /^[\w$-]+/.exec(s.slice(c));
  const end = m ? c + m[0].length : Math.min(c + 1, s.length);
  return { start: { line: l, character: c }, end: { line: l, character: end > c ? end : c } };
}

export function toLsp(d: Diagnostic, text: string): LspDiagnostic {
  const name = CODES[d.code as keyof typeof CODES];
  return {
    range: d.span
      ? { start: { line: d.span.line - 1, character: d.span.col - 1 }, end: { line: d.span.endLine - 1, character: d.span.endCol - 1 } }
      : rangeOf(text, d.line, d.col),
    severity: d.severity === 'error' ? 1 : 2,
    code: name ? `${d.code} ${name}` : d.code,
    codeDescription: { href: docsUrl(d.code) },
    source: 'sinter',
    message: d.message + (d.hint ? `\nhint: ${d.hint}` : ''),
  };
}

const uriToPath = (uri: string) => fileURLToPath(uri);
const pathToUri = (path: string) => pathToFileURL(path).href;

export interface ServerOptions {
  exit?: (code: number) => void;
  /** milliseconds between the last change and the type check (default TYPECHECK_DELAY) */
  typecheckDelay?: number;
  /** TypeScript's `tsc` script for every project (default: resolved from each project) */
  tsc?: string;
}

export function startServer(input: Readable, output: Writable, o: ServerOptions = {}): Connection {
  const conn = new Connection(input, output);
  const last = new Map<string, string>();
  /** per project root: the TypeScript bridge, 'cli' for TypeScript before 7 (checked on save), or 'none' */
  const typescript = new Map<string, TypeScriptBridge | 'cli' | 'none'>();
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  const delay = o.typecheckDelay ?? TYPECHECK_DELAY;
  let disposed = false;

  const modeOf = (root: string): TypeScriptBridge | 'cli' | 'none' => {
    let m = typescript.get(root);
    if (m) return m;
    try {
      const tsc = o.tsc ?? findTsc(root);
      m = typescriptMajor(tsc) >= 7 ? new TypeScriptBridge(root, tsc) : 'cli';
    } catch {
      m = 'none';
    }
    typescript.set(root, m);
    return m;
  };

  const typecheck = async (state: ProjectState) => {
    const mode = modeOf(state.root);
    if (mode === 'none') return;
    if (mode === 'cli') {
      const p = state.project;
      const r = check({ root: state.root, units: [...state.units.values()], helpers: p.helpers, types: p.types, openapi: p.openapi, tsc: o.tsc ?? findTsc(state.root), messagesTypes: p.messagesTypes });
      await workspace.setTypes(state, '*', r.diagnostics);
      return;
    }
    await mode.update(state.project, state.units);
    for (const page of state.units.keys()) await workspace.setTypes(state, page, await mode.diagnostics(page));
  };

  const schedule = (state: ProjectState, wait: number) => {
    clearTimeout(timers.get(state.root));
    timers.set(state.root, setTimeout(() => {
      timers.delete(state.root);
      typecheck(state).catch((e: unknown) => disposed || process.stderr.write(`sinter lsp: type check failed: ${e instanceof Error ? e.stack : String(e)}\n`));
    }, wait));
  };

  const workspace = new Workspace({
    compiled(state) {
      // before TypeScript 7 the check runs `tsc` once per save instead
      if (modeOf(state.root) !== 'cli') schedule(state, delay);
    },
    publish(file, diagnostics) {
      let text = '';
      try { text = workspace.read(file); } catch { /* deleted: ranges fall back to line starts */ }
      const params = { uri: pathToUri(file), diagnostics: diagnostics.map((d) => toLsp(d, text)) };
      const json = JSON.stringify(params.diagnostics);
      if (last.get(file) === json) return;
      last.set(file, json);
      conn.notify('textDocument/publishDiagnostics', params);
    },
  });
  let watchDynamic = false;
  let shutdown = false;
  /** the client resolves code actions lazily (`codeAction/resolve` fills in `edit`) */
  let resolveEdits = false;
  /** the client applies `CreateFile` in workspace edits */
  let canCreate = false;
  /** the client inserts snippets (a path's parameters as placeholders) */
  let snippets = false;

  conn.onRequest('initialize', (params: any) => {
    watchDynamic = !!params?.capabilities?.workspace?.didChangeWatchedFiles?.dynamicRegistration;
    resolveEdits = !!params?.capabilities?.textDocument?.codeAction?.resolveSupport?.properties?.includes('edit');
    const we = params?.capabilities?.workspace?.workspaceEdit;
    canCreate = !!we?.documentChanges && !!we?.resourceOperations?.includes('create');
    snippets = !!params?.capabilities?.textDocument?.completion?.completionItem?.snippetSupport;
    const folders: string[] = (params?.workspaceFolders ?? []).map((f: { uri: string }) => uriToPath(f.uri));
    if (!folders.length && params?.rootUri) folders.push(uriToPath(params.rootUri));
    // load the projects of the open folders early, so the first open file is quick
    for (const f of folders) void workspace.projectFor(f + '/index.html').catch(() => {});
    return {
      capabilities: {
        // full text on every change
        textDocumentSync: { openClose: true, change: 1, save: { includeText: false } },
        hoverProvider: true,
        completionProvider: { triggerCharacters: ['.', '"', '<', '/', '?', '&', ':'], resolveProvider: true },
        definitionProvider: true,
        codeActionProvider: { codeActionKinds: ['quickfix', 'refactor.extract'], resolveProvider: true },
      },
      serverInfo: { name: 'sinter' },
    };
  });

  conn.onNotification('initialized', () => {
    if (!watchDynamic) return;
    void conn.request('client/registerCapability', {
      registrations: [{
        id: 'sinter-watch',
        method: 'workspace/didChangeWatchedFiles',
        registerOptions: {
          watchers: [
            { globPattern: '**/*.html' },
            { globPattern: '**/vite.config.{js,ts,mjs,mts,cjs,cts}' },
            { globPattern: '**/src/sinter.{helpers,types,config}.{js,ts}' },
            { globPattern: '**/src/sinter.types.d.ts' },
            { globPattern: '**/*.{yml,yaml,json}' },
            { globPattern: '**/src/**/*.{js,ts}' },
          ],
        },
      }],
    }).catch(() => {});
  });

  const local = (uri: string) => uri.startsWith('file:');
  conn.onNotification('textDocument/didOpen', (p: any) => {
    if (local(p.textDocument.uri)) return workspace.open(uriToPath(p.textDocument.uri), p.textDocument.text);
  });
  conn.onNotification('textDocument/didChange', (p: any) => {
    const text = p.contentChanges[p.contentChanges.length - 1]?.text;
    if (local(p.textDocument.uri) && typeof text === 'string') return workspace.change(uriToPath(p.textDocument.uri), text);
  });
  conn.onNotification('textDocument/didClose', (p: any) => {
    if (local(p.textDocument.uri)) return workspace.close(uriToPath(p.textDocument.uri));
  });
  conn.onNotification('textDocument/didSave', async (p: any) => {
    if (!local(p.textDocument.uri)) return;
    const file = uriToPath(p.textDocument.uri);
    await workspace.fileChanged(file);
    const state = await workspace.projectFor(file);
    if (modeOf(state.root) === 'cli') schedule(state, 0);
  });
  conn.onNotification('workspace/didChangeWatchedFiles', async (p: any) => {
    const files = (p.changes ?? []).filter((c: { uri: string }) => local(c.uri)).map((c: { uri: string }) => uriToPath(c.uri));
    for (const m of typescript.values()) if (m instanceof TypeScriptBridge) m.filesChanged(files.filter((f: string) => !f.endsWith('.html')));
    for (const f of files) await workspace.fileChanged(f);
  });

  /** The component or layout a tag names in a project, with its file's text (open buffers first). */
  const tagFile = (root: string, tag: string): TagFile | null => {
    for (const [dir, layout] of [['src/components', false], ['src/layouts', true]] as const) {
      const file = join(root, dir, `${tag}.html`);
      let text: string;
      try { text = workspace.read(file); } catch { continue; }
      return { kind: layout ? 'layout' : HEAD_DECL.test(text) ? 'head' : 'component', file, text };
    }
    return null;
  };
  /** every component and layout of a project */
  const tagFiles = (root: string) => {
    const out: Array<{ name: string } & Omit<TagFile, 'text'>> = [];
    for (const dir of ['src/components', 'src/layouts']) {
      let names: string[] = [];
      try { names = readdirSync(join(root, dir)).filter((f) => /^[a-z][a-z0-9]*(-[a-z0-9]+)+\.html$/.test(f)).map((f) => f.slice(0, -5)); } catch { /* none */ }
      for (const n of names) { const t = tagFile(root, n); if (t) out.push({ name: n, kind: dir === 'src/layouts' ? 'layout' : t.kind, file: t.file }); }
    }
    return out;
  };
  const rangeAt = (text: string, from: number, to: number) => {
    const pos = (o: number) => { const before = text.slice(0, o).split('\n'); return { line: before.length - 1, character: before[before.length - 1]!.length }; };
    return { start: pos(from), end: pos(to) };
  };

  conn.onRequest('textDocument/hover', async (p: any) => {
    if (!local(p.textDocument.uri)) return null;
    const file = uriToPath(p.textDocument.uri);
    // a component's or layout's tag: its props and slots
    const tag = componentAt(workspace.read(file), p.position.line, p.position.character);
    if (tag !== null) {
      const root = (await workspace.projectFor(file)).root;
      const t = tagFile(root, tag);
      if (t) return { contents: { kind: 'markdown', value: tagHover(tag, t, relative(root, t.file).split('\\').join('/')) } };
    }
    const state = await workspace.projectFor(file);
    // a path to an API: the URL it calls, the operation and what it returns
    const page = workspace.read(file);
    const path = pathHover(page, offsetOf(page, p.position.line, p.position.character), state.project, (f) => relative(state.root, f).split('\\').join('/'));
    if (path) return { contents: { kind: 'markdown', value: path } };
    const mode = modeOf(state.root);
    if (!(mode instanceof TypeScriptBridge)) return null;
    // the shadows must reflect the latest edit
    await mode.update(state.project, state.units);
    return mode.hover(file, p.position.line + 1, p.position.character + 1);
  });

  /** the bridge for a file's project, with its shadows brought up to date */
  const bridgeFor = async (file: string) => {
    const state = await workspace.projectFor(file);
    const mode = modeOf(state.root);
    if (!(mode instanceof TypeScriptBridge)) return null;
    await mode.update(state.project, state.units);
    return { bridge: mode, state };
  };

  conn.onRequest('textDocument/completion', async (p: any) => {
    if (!local(p.textDocument.uri)) return null;
    const file = uriToPath(p.textDocument.uri);
    // `slot="…"` and tags: sinter's own, from the components' and layouts' files
    const text = workspace.read(file);
    const offset = offsetOf(text, p.position.line, p.position.character);
    const { root, project: proj } = await workspace.projectFor(file);
    // a path to an API: its operations, ranked here (`isIncomplete`: asked again as you type), or its query parameters
    const paths = pathCompletions(text, offset, proj, snippets);
    if (paths) return { isIncomplete: true, items: paths.map((c) => ({ label: c.label, kind: 18, detail: c.detail, filterText: c.filterText, sortText: c.sortText, ...(c.documentation ? { documentation: { kind: 'markdown', value: c.documentation } } : {}), ...(c.snippet ? { insertTextFormat: 2 } : {}), textEdit: { range: rangeAt(text, c.from, c.to), newText: c.insert } })) };
    const slots = slotCompletions(text, offset, (t) => tagFile(root, t));
    if (slots) return { isIncomplete: false, items: slots.map((s) => ({ label: s.label, kind: 12, detail: s.detail, ...(s.documentation ? { documentation: { kind: 'markdown', value: s.documentation } } : {}), textEdit: { range: rangeAt(text, s.from, s.to), newText: s.label } })) };
    const tags = tagCompletions(text, offset, tagFiles(root));
    if (tags?.length) return { isIncomplete: false, items: tags.map((t) => ({ label: t.label, kind: 7, detail: t.detail, textEdit: { range: rangeAt(text, t.from, t.to), newText: t.label } })) };
    const b = await bridgeFor(file);
    return b ? b.bridge.completion(file, p.position.line + 1, p.position.character + 1, p.context) : null;
  });

  conn.onRequest('completionItem/resolve', async (item: any) => {
    const m = item?.data?.sinter ? typescript.get(item.data.sinter) : null;
    return m instanceof TypeScriptBridge ? m.resolve(item) : item;
  });

  const location = (t: Target) => {
    let text = '';
    try { text = workspace.read(t.file); } catch { /* the target's range falls back to its start */ }
    const range = t.endLine !== undefined && t.endCol !== undefined
      ? { start: { line: t.line - 1, character: t.col - 1 }, end: { line: t.endLine - 1, character: t.endCol - 1 } }
      : rangeOf(text, t.line, t.col);
    return { uri: pathToUri(t.file), range };
  };

  conn.onRequest('textDocument/definition', async (p: any) => {
    if (!local(p.textDocument.uri)) return null;
    const file = uriToPath(p.textDocument.uri);
    // a component's or layout's tag opens its file; a `slot="…"` value, the `<slot>` it names
    const text = workspace.read(file);
    const root = (await workspace.projectFor(file)).root;
    const tag = componentAt(text, p.position.line, p.position.character);
    if (tag !== null) {
      for (const dir of ['src/components', 'src/layouts']) {
        const target = join(root, dir, `${tag}.html`);
        if (existsSync(target)) return [{ uri: pathToUri(target), range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } } }];
      }
    }
    const at = pathDefinition(text, offsetOf(text, p.position.line, p.position.character), (await workspace.projectFor(file)).project, (f) => workspace.read(f));
    if (at) return [{ uri: pathToUri(at.file), range: { start: { line: at.line - 1, character: at.col - 1 }, end: { line: at.line - 1, character: at.col - 1 } } }];
    const slot = slotDefinition(text, offsetOf(text, p.position.line, p.position.character), (t) => tagFile(root, t));
    if (slot) return [{ uri: pathToUri(slot.file), range: { start: { line: slot.line - 1, character: slot.col - 1 }, end: { line: slot.line - 1, character: slot.col - 1 } } }];
    const b = await bridgeFor(file);
    if (!b) return null;
    const targets = await b.bridge.definition(file, p.position.line + 1, p.position.character + 1, b.state.project);
    return targets.map(location);
  });

  /** what the extraction needs to know about a file; types come from TypeScript 7, asked once it is up to date */
  const extractContext = async (file: string): Promise<ExtractContext> => {
    const state = await workspace.projectFor(file);
    const mode = modeOf(state.root);
    const read = (f: string) => { try { return workspace.read(f); } catch { return null; } };
    let ready: Promise<void> | null = null;
    const types = state.project.types ? read(state.project.types) : null;
    return {
      file, text: workspace.read(file), root: state.root, units: [...state.units.values()], project: state.project, options: state.options, read,
      trial: (text, helpers, actions) => workspace.trial(state, file, text, helpers, actions),
      typeNames: types ? typeExports(types) : [],
      canCreate,
      ...(mode instanceof TypeScriptBridge ? {
        typeAt: async (line: number, col: number) => {
          ready ??= mode.update(state.project, state.units);
          await ready;
          return mode.typeAt(file, line, col);
        },
      } : {}),
    };
  };

  /** Extract actions for a range (a selection, or a diagnostic's), with the edit or the data to resolve it. */
  const extractActions = async (uri: string, range: Range, diagnostic: LspDiagnostic | null) => {
    const file = uriToPath(uri);
    let ctx: ExtractContext;
    try { ctx = await extractContext(file); } catch { return []; }
    const list: Plan[] = diagnostic ? fixPlans(ctx, diagnostic) : plans(ctx, range);
    const out = [];
    for (const [index, plan] of list.entries()) {
      const action: Record<string, unknown> = diagnostic
        ? { title: plan.title, kind: 'quickfix', diagnostics: [diagnostic], isPreferred: index === 0 }
        : { title: plan.title, kind: 'refactor.extract' };
      if (resolveEdits) action.data = { sinter: 'extract', uri, range, index, title: plan.title, diagnostic };
      else action.edit = await editFor(ctx, plan, pathToUri);
      out.push(action);
    }
    return out;
  };

  conn.onRequest('textDocument/codeAction', async (p: any) => {
    if (!local(p.textDocument.uri)) return [];
    let text: string;
    try { text = workspace.read(uriToPath(p.textDocument.uri)); } catch { return []; }
    const only: string[] | undefined = p.context?.only;
    const wants = (kind: string) => !only || only.some((k) => kind === k || kind.startsWith(k + '.'));
    const actions: unknown[] = [];
    for (const d of p.context?.diagnostics ?? []) {
      if (d.source !== 'sinter') continue;
      if (wants('quickfix') && EXTRACT_FIX_CODES.has(String(d.code).split(' ')[0])) actions.push(...await extractActions(p.textDocument.uri, d.range, d));
      // a path or a configured shape: the attribute rewritten, or removed
      const fix = wants('quickfix') ? pathFix(text, offsetOf(text, d.range.start.line, d.range.start.character), offsetOf(text, d.range.end.line, d.range.end.character), String(d.code).split(' ')[0]!, d.message.split('\nhint:')[0]) : null;
      if (fix) {
        actions.push({ title: fix.title, kind: 'quickfix', isPreferred: true, diagnostics: [d], edit: { changes: { [p.textDocument.uri]: [{ range: rangeAt(text, fix.from, fix.to), newText: fix.text }] } } });
        continue;
      }
      const edit = didYouMeanEdit(text, d.range, d.message);
      if (!edit || !wants('quickfix')) continue;
      actions.push({
        title: `Change to '${edit.newText}'`, kind: 'quickfix', isPreferred: true, diagnostics: [d],
        edit: { changes: { [p.textDocument.uri]: [edit] } },
      });
    }
    if (wants('refactor.extract') && p.range) actions.push(...await extractActions(p.textDocument.uri, p.range, null));
    return actions;
  });

  conn.onRequest('codeAction/resolve', async (action: any) => {
    const d = action?.data;
    if (d?.sinter !== 'extract' || !local(d.uri)) return action;
    const ctx = await extractContext(uriToPath(d.uri));
    const list = d.diagnostic ? fixPlans(ctx, d.diagnostic) : plans(ctx, d.range);
    const plan = list[d.index];
    // the file changed since the list was made: nothing to apply
    if (!plan || plan.title !== d.title) return action;
    return { ...action, edit: await editFor(ctx, plan, pathToUri) };
  });

  const dispose = () => {
    disposed = true;
    for (const t of timers.values()) clearTimeout(t);
    timers.clear();
    for (const m of typescript.values()) if (m instanceof TypeScriptBridge) m.dispose();
    typescript.clear();
  };
  conn.onRequest('shutdown', () => { shutdown = true; dispose(); return null; });
  const closed = conn.onClose;
  conn.onClose = () => { dispose(); closed?.(); };
  conn.onNotification('exit', () => { conn.close(); o.exit?.(shutdown ? 0 : 1); });
  conn.onUnhandled = () => {};
  return conn;
}

/** The tag name (with a `-`, as a component's) when the 0-based position is on it in a start or end tag, else null. */
export function componentAt(text: string, line: number, character: number): string | null {
  const t = text.split('\n')[line] ?? '';
  for (const m of t.matchAll(/<\/?([a-z][a-z0-9]*(?:-[a-z0-9]+)+)/g)) {
    const start = m.index! + m[0].length - m[1]!.length;
    if (character >= start && character <= start + m[1]!.length) return m[1]!;
  }
  return null;
}
