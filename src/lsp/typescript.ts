// The bridge to TypeScript 7's own language server (`tsc --lsp --stdio`). It keeps
// one shadow file per page open there, pulls type errors for them and answers hovers,
// mapping positions between the HTML and the shadows.
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { COMPILER_OPTIONS, shadowOf, shadowPath, typeDiagnostic, writeSupport, type Support } from '../check/index.js';
import { mapPosition, shadowPosition, type Region } from '../check/shadow.js';
import type { CheckUnit } from '../compiler/check-unit.js';
import type { Diagnostic } from '../compiler/index.js';
import type { Project } from '../project.js';
import { Connection } from './rpc.js';
import { specLocation } from './spec-location.js';

/** The major version of the project's TypeScript, from the package next to its `tsc`. */
export function typescriptMajor(tsc: string): number {
  try {
    const pkg = JSON.parse(readFileSync(join(dirname(tsc), '..', 'package.json'), 'utf8')) as { version?: string };
    return Number(/^(\d+)/.exec(pkg.version ?? '')?.[1] ?? 0);
  } catch {
    return 0;
  }
}

interface OpenShadow {
  unit: CheckUnit;
  path: string;
  uri: string;
  text: string;
  lines: string[];
  regions: Region[];
  brokenFrom: number | null;
  version: number;
}

/** A place in a file, 1-based; `end` when known. */
export interface Target { file: string; line: number; col: number; endLine?: number; endCol?: number }

/** Names the shadow declares for itself, never offered as completions. */
const INTERNAL = /^(\$any|\$item|\$p|\$e\d+)$/;

interface LspRange { start: { line: number; character: number }; end: { line: number; character: number } }

export class TypeScriptBridge {
  private conn: Connection;
  private child: ChildProcess;
  private ready: Promise<unknown>;
  private shadows = new Map<string, OpenShadow>();
  private support: Support | null = null;
  readonly outDir: string;

  constructor(readonly root: string, tsc: string) {
    this.outDir = join(root, '.sinter', 'lsp');
    mkdirSync(this.outDir, { recursive: true });
    writeFileSync(join(this.outDir, 'tsconfig.json'), JSON.stringify({ compilerOptions: COMPILER_OPTIONS, include: ['**/*.js', '*.d.ts'] }, null, 2) + '\n');
    this.child = spawn(process.execPath, [tsc, '--lsp', '--stdio'], { cwd: this.outDir, stdio: ['pipe', 'pipe', 'ignore'] });
    this.conn = new Connection(this.child.stdout!, this.child.stdin!);
    // workspace/configuration, client/registerCapability, progress: nothing to say
    this.conn.requestFallback = (method, params: any) => (method === 'workspace/configuration' ? (params?.items ?? []).map(() => null) : null);
    this.conn.onUnhandled = () => {};
    this.child.on('error', () => this.conn.close());
    this.child.stdin!.on('error', () => this.conn.close());
    this.ready = this.conn.request('initialize', {
      processId: process.pid,
      rootUri: pathToFileURL(this.outDir).href,
      capabilities: {
        textDocument: { diagnostic: {}, hover: { contentFormat: ['markdown', 'plaintext'] }, synchronization: {} },
        workspace: { configuration: true, didChangeWatchedFiles: { dynamicRegistration: true } },
      },
    }).then(() => this.conn.notify('initialized', {}), () => { /* closed before it started; requests fail on their own */ });
  }

  /** Brings the shadows in line with the pages' latest check units. */
  async update(project: Project, units: Map<string, CheckUnit>): Promise<void> {
    await this.ready;
    const support = writeSupport({ root: this.root, outDir: this.outDir, types: project.types, openapi: project.openapi });
    // a reloaded project may have new type names or spec declarations
    if (this.support && JSON.stringify(support) !== JSON.stringify(this.support)) this.filesChanged([support.declarations, ...support.openapi]);
    this.support = support;
    for (const [page, unit] of units) {
      const s = shadowOf(unit, support, this.root, project.helpers);
      const prev = this.shadows.get(page);
      if (prev?.text === s.text) { prev.unit = unit; prev.regions = s.regions; prev.brokenFrom = s.brokenFrom; continue; }
      const path = shadowPath(support, this.root, page);
      const uri = pathToFileURL(path).href;
      const next: OpenShadow = { unit, path, uri, text: s.text, lines: s.text.split('\n'), regions: s.regions, brokenFrom: s.brokenFrom, version: (prev?.version ?? 0) + 1 };
      this.shadows.set(page, next);
      if (prev) {
        this.conn.notify('textDocument/didChange', { textDocument: { uri, version: next.version }, contentChanges: [{ text: s.text }] });
      } else {
        // on disk too, so the tsconfig's `include` puts it in the project
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, s.text);
        this.conn.notify('textDocument/didOpen', { textDocument: { uri, languageId: 'javascript', version: next.version, text: s.text } });
      }
    }
    for (const [page, s] of this.shadows) {
      if (units.has(page)) continue;
      this.conn.notify('textDocument/didClose', { textDocument: { uri: s.uri } });
      rmSync(s.path, { force: true });
      this.shadows.delete(page);
    }
  }

  /** TypeScript's errors in a page's expressions, at their HTML positions. */
  async diagnostics(page: string): Promise<Diagnostic[]> {
    const s = this.shadows.get(page);
    if (!s) return [];
    const report = await this.conn.request<{ items?: Array<{ range: LspRange; severity?: number; code?: number | string; message: string }> }>(
      'textDocument/diagnostic', { textDocument: { uri: s.uri } });
    const out: Diagnostic[] = [];
    for (const item of report?.items ?? []) {
      // hints and suggestions (unused imports of the shadow itself) are not the page's business
      if (item.severity !== 1) continue;
      const { start, end } = item.range;
      // broken expressions are the compiler's to report
      if (s.brokenFrom !== null && start.line + 1 >= s.brokenFrom) continue;
      const d = typeDiagnostic(s.unit, s.regions, start.line + 1, start.character + 1, `TS${item.code}`, item.message, this.root);
      const a = mapPosition(s.regions, start.line + 1, start.character + 1);
      const b = mapPosition(s.regions, end.line + 1, end.character + 1);
      if (a && b && a.file === b.file && (b.line > a.line || (b.line === a.line && b.col > a.col))) {
        d.span = { line: a.line, col: a.col, endLine: b.line, endCol: b.col };
      }
      out.push(d);
    }
    return out;
  }

  /** The page shadow and shadow position for a 1-based HTML position, if it is in an expression. */
  locate(file: string, line: number, col: number): { shadow: OpenShadow; line: number; col: number } | null {
    // the page itself first, then pages that include `file`
    const order = [...this.shadows].sort(([a], [b]) => Number(b === file) - Number(a === file));
    for (const [, s] of order) {
      const p = shadowPosition(s.regions, s.lines, file, line, col);
      if (p) return { shadow: s, ...p };
    }
    return null;
  }

  /** Maps a shadow range back to the HTML; null when it is not inside one expression. */
  private toHtml(s: OpenShadow, r: LspRange, file: string): LspRange | null {
    const a = mapPosition(s.regions, r.start.line + 1, r.start.character + 1);
    const b = mapPosition(s.regions, r.end.line + 1, r.end.character + 1);
    if (!a || !b || a.file !== file || b.file !== file) return null;
    return { start: { line: a.line - 1, character: a.col - 1 }, end: { line: b.line - 1, character: b.col - 1 } };
  }

  async hover(file: string, line: number, col: number): Promise<{ contents: unknown; range?: LspRange } | null> {
    await this.ready;
    const at = this.locate(file, line, col);
    if (!at) return null;
    const h = await this.conn.request<{ contents: unknown; range?: LspRange } | null>('textDocument/hover', {
      textDocument: { uri: at.shadow.uri }, position: { line: at.line - 1, character: at.col - 1 },
    });
    if (!h) return null;
    const range = h.range ? this.toHtml(at.shadow, h.range, file) : null;
    return range ? { contents: h.contents, range } : { contents: h.contents };
  }

  /** Completions at a 1-based HTML position inside an expression, with edits mapped to the HTML. */
  async completion(file: string, line: number, col: number, context: unknown): Promise<{ isIncomplete: boolean; items: any[] } | null> {
    await this.ready;
    const at = this.locate(file, line, col);
    if (!at) return null;
    const r = await this.conn.request<any>('textDocument/completion', {
      textDocument: { uri: at.shadow.uri }, position: { line: at.line - 1, character: at.col - 1 }, context,
    });
    if (!r) return null;
    const list: any[] = Array.isArray(r) ? r : r.items ?? [];
    const items: any[] = [];
    for (const item of list) {
      // the shadow's own names, and auto-imports that would edit the shadow's header
      if (INTERNAL.test(item.label) || item.additionalTextEdits?.length) continue;
      const edit = item.textEdit;
      if (edit) {
        const range = edit.range ?? edit.replace;
        const mapped = range && this.toHtml(at.shadow, range, file);
        if (mapped) item.textEdit = { range: mapped, newText: edit.newText };
        else delete item.textEdit;
      }
      item.data = { sinter: this.root, ts: item.data ?? null, uri: at.shadow.uri };
      items.push(item);
    }
    return { isIncomplete: Array.isArray(r) ? false : !!r.isIncomplete, items };
  }

  /** Details for a completion item this bridge returned (documentation, signature). */
  async resolve(item: any): Promise<any> {
    const ours = item.data;
    const r = await this.conn.request<any>('completionItem/resolve', { ...item, data: ours.ts, textEdit: undefined });
    return { ...item, documentation: r?.documentation ?? item.documentation, detail: r?.detail ?? item.detail };
  }

  /**
   * Definitions of the name at a 1-based HTML position: where the HTML declares it (resources,
   * state, loop variables), the spec for types generated from OpenAPI, else TypeScript's own
   * answer (helpers, the types module).
   */
  async definition(file: string, line: number, col: number, project: Project): Promise<Target[]> {
    await this.ready;
    const at = this.locate(file, line, col);
    if (!at) return [];
    const r = await this.conn.request<any>('textDocument/definition', {
      textDocument: { uri: at.shadow.uri }, position: { line: at.line - 1, character: at.col - 1 },
    });
    const list: any[] = !r ? [] : Array.isArray(r) ? r : [r];
    const out: Target[] = [];
    for (const d of list) {
      const uri: string = d.targetUri ?? d.uri;
      const range: LspRange = d.targetSelectionRange ?? d.range;
      if (!uri?.startsWith('file:') || !range) continue;
      const path = fileURLToPath(uri);
      const shadow = [...this.shadows.values()].find((s) => s.path === path);
      if (shadow) {
        const loc = mapPosition(shadow.regions, range.start.line + 1, range.start.character + 1);
        if (loc) out.push({ file: loc.file, line: loc.line, col: loc.col });
        continue;
      }
      const spec = this.support?.openapi.indexOf(path) ?? -1;
      if (spec >= 0) {
        const text = readFileSync(path, 'utf8').split('\n')[range.start.line] ?? '';
        const name = /^export (?:interface|type) ([\w$]+)/.exec(text)?.[1];
        const ident = text.slice(range.start.character, range.end.character);
        const specFile = project.openapi[spec]?.file;
        const loc = name && specFile ? specLocation(specFile, name, ident !== name ? ident : undefined) : null;
        if (loc && specFile) out.push({ file: specFile, ...loc });
        continue;
      }
      // sinter's own declarations say nothing useful about the app
      if (path === this.support?.declarations) continue;
      out.push({ file: path, line: range.start.line + 1, col: range.start.character + 1, endLine: range.end.line + 1, endCol: range.end.character + 1 });
    }
    return out;
  }

  /** Tells TypeScript that files it may have read changed on disk. */
  filesChanged(files: string[]): void {
    if (!files.length) return;
    this.conn.notify('workspace/didChangeWatchedFiles', { changes: files.map((f) => ({ uri: pathToFileURL(f).href, type: 2 })) });
  }

  dispose(): void {
    this.conn.close();
    this.child.kill();
  }
}
