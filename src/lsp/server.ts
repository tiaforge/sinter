// `sinter lsp`: a language server for sinter pages over stdio. It compiles open
// buffers as they change and publishes the compiler's diagnostics.
import type { Readable, Writable } from 'node:stream';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { CODES, docsUrl, type Diagnostic } from '../compiler/index.js';
import { Connection } from './rpc.js';
import { Workspace } from './workspace.js';

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

export function startServer(input: Readable, output: Writable, o: { exit?: (code: number) => void } = {}): Connection {
  const conn = new Connection(input, output);
  const last = new Map<string, string>();
  const workspace = new Workspace({
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

  conn.onRequest('initialize', (params: any) => {
    watchDynamic = !!params?.capabilities?.workspace?.didChangeWatchedFiles?.dynamicRegistration;
    const folders: string[] = (params?.workspaceFolders ?? []).map((f: { uri: string }) => uriToPath(f.uri));
    if (!folders.length && params?.rootUri) folders.push(uriToPath(params.rootUri));
    // load the projects of the open folders early, so the first open file is quick
    for (const f of folders) void workspace.projectFor(f + '/index.html').catch(() => {});
    return {
      capabilities: {
        // full text on every change
        textDocumentSync: { openClose: true, change: 1, save: { includeText: false } },
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
  conn.onNotification('textDocument/didSave', (p: any) => {
    if (local(p.textDocument.uri)) return workspace.fileChanged(uriToPath(p.textDocument.uri));
  });
  conn.onNotification('workspace/didChangeWatchedFiles', async (p: any) => {
    for (const c of p.changes ?? []) if (local(c.uri)) await workspace.fileChanged(uriToPath(c.uri));
  });

  conn.onRequest('shutdown', () => { shutdown = true; return null; });
  conn.onNotification('exit', () => { conn.close(); o.exit?.(shutdown ? 0 : 1); });
  conn.onUnhandled = () => {};
  return conn;
}
