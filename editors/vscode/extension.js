// sinter for VS Code: starts the project's own `sinter lsp` for HTML files in a
// sinter project. One language client per sinter installation, so each project uses
// the version it depends on. Attribute completion comes from `html-custom-data.json`.
'use strict';
const vscode = require('vscode');
const { LanguageClient, TransportKind } = require('vscode-languageclient/node');
const { findServer } = require('./server-path.js');

/** cli path → { client, root } */
const clients = new Map();
let output;

function serverFor(document) {
  if (document.uri.scheme !== 'file' || document.languageId !== 'html') return null;
  const folder = vscode.workspace.getWorkspaceFolder(document.uri);
  const override = vscode.workspace.getConfiguration('sinter', document.uri).get('server.path');
  return findServer(document.uri.fsPath, folder && folder.uri.fsPath, override || undefined);
}

/** Only the client whose installation a document belongs to handles it (projects can nest). */
function owns(root, document) {
  const s = serverFor(document);
  return !!s && s.root === root;
}

function middleware(root) {
  const guard = (fallback) => (document, ...rest) => {
    const next = rest[rest.length - 1];
    return owns(root, document) ? next(document, ...rest.slice(0, -1)) : fallback;
  };
  return {
    didOpen: guard(Promise.resolve()),
    didClose: guard(Promise.resolve()),
    didSave: guard(Promise.resolve()),
    didChange: (event, next) => (owns(root, event.document) ? next(event) : Promise.resolve()),
    provideHover: guard(null),
    provideCompletionItem: guard(null),
    provideDefinition: guard(null),
    provideCodeActions: guard(null),
  };
}

async function start(server) {
  if (clients.has(server.cli)) return;
  const run = { module: server.cli, args: ['lsp'], transport: TransportKind.stdio, options: { cwd: server.root } };
  const client = new LanguageClient('sinter', 'sinter', { run, debug: run }, {
    documentSelector: [{ scheme: 'file', language: 'html', pattern: `${server.root.replace(/\\/g, '/')}/**/*` }],
    outputChannel: output,
    middleware: middleware(server.root),
  });
  clients.set(server.cli, { client, root: server.root });
  output.appendLine(`starting ${server.cli} for ${server.root}`);
  try {
    await client.start();
  } catch (e) {
    output.appendLine(`sinter lsp failed to start: ${e && e.message ? e.message : e}`);
    clients.delete(server.cli);
  }
}

function consider(document) {
  const server = serverFor(document);
  if (server) void start(server);
}

async function stopAll() {
  const all = [...clients.values()];
  clients.clear();
  await Promise.all(all.map(({ client }) => client.stop().catch(() => {})));
}

function activate(context) {
  output = vscode.window.createOutputChannel('sinter');
  context.subscriptions.push(
    output,
    vscode.workspace.onDidOpenTextDocument(consider),
    vscode.commands.registerCommand('sinter.restart', async () => {
      await stopAll();
      vscode.workspace.textDocuments.forEach(consider);
    }),
    vscode.workspace.onDidChangeConfiguration(async (e) => {
      if (!e.affectsConfiguration('sinter.server.path')) return;
      await stopAll();
      vscode.workspace.textDocuments.forEach(consider);
    }),
  );
  vscode.workspace.textDocuments.forEach(consider);
}

function deactivate() {
  return stopAll();
}

module.exports = { activate, deactivate, middleware };
