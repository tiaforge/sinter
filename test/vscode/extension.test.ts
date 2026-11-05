// The VS Code extension, with `vscode` and the language client replaced by fakes.
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';

const require = createRequire(import.meta.url);
const ext = resolve(__dirname, '../../editors/vscode');
const { findServer } = require(join(ext, 'server-path.js')) as {
  findServer(file: string, folder?: string, override?: string): { cli: string; root: string } | null;
};

/** a project with sinter installed in node_modules */
function project(): string {
  const root = mkdtempSync(join(tmpdir(), 'sinter-vscode-'));
  const pkg = join(root, 'node_modules/@tiaforge-ui/sinter');
  mkdirSync(join(pkg, 'dist'), { recursive: true });
  writeFileSync(join(pkg, 'package.json'), JSON.stringify({ name: '@tiaforge-ui/sinter', bin: { sinter: './dist/cli.js' } }));
  writeFileSync(join(pkg, 'dist/cli.js'), '');
  mkdirSync(join(root, 'pages'));
  return root;
}

describe('findServer', () => {
  test('the nearest installation above the file', () => {
    const root = project();
    expect(findServer(join(root, 'pages/a.html'), root)).toEqual({ cli: join(root, 'node_modules/@tiaforge-ui/sinter/dist/cli.js'), root });
  });
  test('no sinter, no server', () => {
    expect(findServer(join(mkdtempSync(join(tmpdir(), 'plain-')), 'a.html'))).toBeNull();
  });
  // needs `npm run build` (dist/cli.js) and the example's install
  test.skipIf(!existsSync(resolve(__dirname, '../../dist/cli.js')) || !existsSync(resolve(__dirname, '../../examples/realworld/node_modules')))('the sinter repository serves itself; its examples their own install', () => {
    const repo = resolve(__dirname, '../..');
    expect(findServer(join(repo, 'docs/recipes/list-filter.html'))).toEqual({ cli: join(repo, 'dist/cli.js'), root: repo });
    const rw = join(repo, 'examples/realworld');
    expect(findServer(join(rw, 'index.html'))!.root).toBe(rw);
  });
  test('a configured path wins, relative to the workspace folder', () => {
    const root = project();
    writeFileSync(join(root, 'cli.js'), '');
    expect(findServer(join(root, 'pages/a.html'), root, 'cli.js')).toEqual({ cli: join(root, 'cli.js'), root });
  });
});

describe('extension', () => {
  const clients: Array<{ name: string; server: any; options: any; started: boolean }> = [];
  const documents: any[] = [];
  let opened: ((d: any) => void) | null = null;
  const Module = require('node:module') as { _load: (request: string, ...rest: unknown[]) => unknown };
  const load = Module._load;
  const doc = (path: string) => ({ uri: { scheme: 'file', fsPath: path }, languageId: 'html' });

  beforeAll(() => {
    const vscode = {
      workspace: {
        textDocuments: documents,
        getWorkspaceFolder: () => undefined,
        getConfiguration: () => ({ get: () => '' }),
        onDidOpenTextDocument: (f: (d: any) => void) => { opened = f; return { dispose() {} }; },
        onDidChangeConfiguration: () => ({ dispose() {} }),
      },
      window: { createOutputChannel: () => ({ appendLine() {}, dispose() {} }) },
      commands: { registerCommand: () => ({ dispose() {} }) },
    };
    class LanguageClient {
      started = false;
      constructor(_id: string, public name: string, public server: any, public options: any) { clients.push(this as any); }
      async start() { this.started = true; }
      async stop() {}
    }
    Module._load = function (request: string, ...rest: unknown[]) {
      if (request === 'vscode') return vscode;
      if (request === 'vscode-languageclient/node') return { LanguageClient, TransportKind: { stdio: 0 } };
      return load.call(this, request, ...rest);
    };
  });
  afterAll(() => { Module._load = load; });

  test('one server per installation, started from the project', async () => {
    const a = project();
    const b = project();
    documents.push(doc(join(a, 'pages/x.html')), { uri: { scheme: 'file', fsPath: join(a, 'notes.md') }, languageId: 'markdown' });
    const { activate } = require(join(ext, 'extension.js'));
    activate({ subscriptions: [] });
    await new Promise((r) => setTimeout(r, 0));
    expect(clients).toHaveLength(1);
    expect(clients[0]!.server.run).toEqual({ module: join(a, 'node_modules/@tiaforge-ui/sinter/dist/cli.js'), args: ['lsp'], transport: 0, options: { cwd: a } });
    expect(clients[0]!.options.documentSelector).toEqual([{ scheme: 'file', language: 'html', pattern: `${a}/**/*` }]);
    expect(clients[0]!.started).toBe(true);

    opened!(doc(join(a, 'index.html')));
    opened!(doc(join(b, 'index.html')));
    await new Promise((r) => setTimeout(r, 0));
    expect(clients.map((c) => c.server.run.options.cwd)).toEqual([a, b]);
  });

  test('a client leaves documents of a nested project to that project\'s server', async () => {
    const outer = project();
    mkdirSync(join(outer, 'app/node_modules/@tiaforge-ui/sinter/dist'), { recursive: true });
    writeFileSync(join(outer, 'app/node_modules/@tiaforge-ui/sinter/package.json'), JSON.stringify({ name: '@tiaforge-ui/sinter', bin: { sinter: './dist/cli.js' } }));
    writeFileSync(join(outer, 'app/node_modules/@tiaforge-ui/sinter/dist/cli.js'), '');
    const { middleware } = require(join(ext, 'extension.js'));
    const m = middleware(outer);
    const next = (..._args: unknown[]) => 'handled';
    expect(m.provideHover(doc(join(outer, 'pages/a.html')), {}, {}, next)).toBe('handled');
    expect(m.provideHover(doc(join(outer, 'app/index.html')), {}, {}, next)).toBeNull();
    expect(m.provideCodeActions(doc(join(outer, 'app/index.html')), {}, {}, {}, next)).toBeNull();
    expect(await m.didOpen(doc(join(outer, 'app/index.html')), next)).toBeUndefined();
    expect(m.didOpen(doc(join(outer, 'pages/a.html')), next)).toBe('handled');
  });
});
