// The language server, driven over in-memory streams the way an editor drives it.
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, test } from 'vitest';
import { Connection } from '../../src/lsp/rpc.js';
import { findTsc } from '../../src/check/index.js';
import { rangeOf, startServer, type LspDiagnostic } from '../../src/lsp/server.js';

const tsc = findTsc(process.cwd());

function project(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'sinter-lsp-'));
  writeFileSync(join(root, 'package.json'), '{"type":"module"}');
  for (const [p, text] of Object.entries(files)) {
    mkdirSync(join(root, p, '..'), { recursive: true });
    writeFileSync(join(root, p), text);
  }
  return root;
}

const open: Connection[] = [];
afterEach(() => { for (const c of open.splice(0)) c.close(); });

/** A server and an editor-side connection to it, with the diagnostics it published per file. */
async function editor(root: string, options: { tsc?: string } = {}) {
  const toServer = new PassThrough();
  const toClient = new PassThrough();
  const server = startServer(toServer, toClient, { tsc: options.tsc ?? tsc, typecheckDelay: 10 });
  const client = new Connection(toClient, toServer);
  open.push(client, server);
  const published = new Map<string, LspDiagnostic[]>();
  const waiters: Array<() => void> = [];
  client.onNotification('textDocument/publishDiagnostics', (p: { uri: string; diagnostics: LspDiagnostic[] }) => {
    published.set(p.uri, p.diagnostics);
    for (const w of waiters.splice(0)) w();
  });
  await client.request('initialize', { processId: null, rootUri: pathToFileURL(root).href, capabilities: {} });
  client.notify('initialized', {});
  const uri = (rel: string) => pathToFileURL(join(root, rel)).href;
  let version = 1;
  return {
    uri,
    open(rel: string, text: string) {
      client.notify('textDocument/didOpen', { textDocument: { uri: uri(rel), languageId: 'html', version: version++, text } });
    },
    change(rel: string, text: string) {
      client.notify('textDocument/didChange', { textDocument: { uri: uri(rel), version: version++ }, contentChanges: [{ text }] });
    },
    /** what was last published for `rel` (nothing: empty) */
    hover(rel: string, line: number, character: number) {
      return client.request<{ contents: { kind: string; value: string }; range?: unknown } | null>('textDocument/hover', { textDocument: { uri: uri(rel) }, position: { line, character } });
    },
    save(rel: string) {
      client.notify('textDocument/didSave', { textDocument: { uri: uri(rel) } });
    },
    /** tells the server files changed on disk, as an editor's file watcher does */
    changed(...rels: string[]) {
      client.notify('workspace/didChangeWatchedFiles', { changes: rels.map((r) => ({ uri: uri(r), type: 2 })) });
    },
    current: (rel: string) => published.get(uri(rel)) ?? [],
    /** waits until the diagnostics published for `rel` satisfy `ok` */
    async diagnostics(rel: string, ok: (d: LspDiagnostic[]) => boolean = () => true): Promise<LspDiagnostic[]> {
      const deadline = Date.now() + 10_000;
      for (;;) {
        const d = published.get(uri(rel));
        if (d && ok(d)) return d;
        if (Date.now() > deadline) throw new Error(`no matching diagnostics for ${rel}; last: ${JSON.stringify(d)}`);
        await new Promise<void>((r) => { waiters.push(r); setTimeout(r, 200); });
      }
    },
  };
}

describe('rangeOf', () => {
  test('covers the name at a 1-based position', () => {
    expect(rangeOf('a\n  <p data-sn-txt="x">', 2, 6)).toEqual({ start: { line: 1, character: 5 }, end: { line: 1, character: 16 } });
  });
  test('one character where no name starts', () => {
    expect(rangeOf('x = (', 1, 5)).toEqual({ start: { line: 0, character: 4 }, end: { line: 0, character: 5 } });
  });
  test('positions past the end are clamped', () => {
    expect(rangeOf('ab', 9, 9)).toEqual({ start: { line: 0, character: 2 }, end: { line: 0, character: 2 } });
  });
});

describe('sinter lsp', () => {
  test('publishes compiler diagnostics as the buffer changes', async () => {
    const root = project({ 'index.html': '<p>hi</p>\n' });
    const e = await editor(root);
    e.open('index.html', '<div data-sn-state="{ count: 0 }">\n  <p data-sn-txt="count"></p>\n  <p data-sn-text="cuont"></p>\n</div>\n');
    const d = await e.diagnostics('index.html', (d) => d.length === 2);
    expect(d.map((x) => x.code).sort()).toEqual(['SN101 unknown-attribute', 'SN201 unknown-identifier']);
    const attr = d.find((x) => x.code.startsWith('SN101'))!;
    // the whole attribute
    expect(attr.range).toEqual({ start: { line: 1, character: 5 }, end: { line: 1, character: 24 } });
    expect(attr.severity).toBe(1);
    expect(attr.codeDescription.href).toBe('https://github.com/tiaforge/sinter/blob/main/docs/diagnostics.md#sn101-unknown-attribute');
    const name = d.find((x) => x.code.startsWith('SN201'))!;
    expect(name.message).toContain('Did you mean `count`?');
    expect(name.range.start).toEqual({ line: 2, character: 19 });
    expect(name.range.end).toEqual({ line: 2, character: 24 });

    e.change('index.html', '<div data-sn-state="{ count: 0 }">\n  <p data-sn-text="count"></p>\n</div>\n');
    await e.diagnostics('index.html', (d) => d.length === 0);
  });

  test('a partial is checked in the context of the pages that include it', async () => {
    const page = '<sn-resource name="contacts" src="/api/contacts" key="id"></sn-resource>\n<div data-sn-state="{ q: \'\' }">\n  <sn-include src="./partials/list.html"></sn-include>\n</div>\n';
    const partial = '<template data-sn-for="c in contacts">\n  <p data-sn-text="c.name + q"></p>\n</template>\n';
    const root = project({ 'index.html': page, 'partials/list.html': partial });
    const e = await editor(root);
    e.open('partials/list.html', partial);
    // `contacts` and `q` come from the page, so the partial has no errors
    expect((await e.diagnostics('partials/list.html')).filter((x) => x.severity === 1)).toEqual([]);

    e.change('partials/list.html', partial.replace('c.name + q', 'c.name + qq'));
    const d = await e.diagnostics('partials/list.html', (d) => d.some((x) => x.code.startsWith('SN201')));
    expect(d.find((x) => x.code.startsWith('SN201'))!.range.start).toEqual({ line: 1, character: 28 });
    // reported once, on the partial, not on the page
    expect(e.current('index.html').filter((x) => x.severity === 1)).toEqual([]);

    e.change('partials/list.html', partial);
    await e.diagnostics('partials/list.html', (d) => d.every((x) => x.severity === 2));
  });

  test('an HTML file that no page includes is compiled as a page', async () => {
    const root = project({ 'index.html': '<p>hi</p>\n' });
    const e = await editor(root);
    e.open('about.html', '<p data-sn-text="nope"></p>\n');
    const d = await e.diagnostics('about.html', (d) => d.length > 0);
    expect(d[0]!.code).toBe('SN201 unknown-identifier');
  });

  test('pages listed in the Vite config are compiled before they are opened', async () => {
    const root = project({
      'vite.config.js': `export default { build: { rollupOptions: { input: { a: 'a.html', b: 'b.html' } } } };\n`,
      'a.html': '<p>ok</p>\n',
      'b.html': '<p data-sn-text="missing"></p>\n',
    });
    const e = await editor(root);
    e.open('a.html', '<p>ok</p>\n');
    const d = await e.diagnostics('b.html');
    expect(d.map((x) => x.code)).toEqual(['SN201 unknown-identifier']);
  });

  test('a changed helpers module reloads the project', async () => {
    const root = project({ 'index.html': '<p>hi</p>\n' });
    const e = await editor(root);
    e.open('index.html', '<p data-sn-text="shout(\'hi\')"></p>\n');
    await e.diagnostics('index.html', (d) => d.some((x) => x.code.startsWith('SN201')));
    mkdirSync(join(root, 'src'), { recursive: true });
    writeFileSync(join(root, 'src/sinter.helpers.js'), 'export const shout = (s) => s.toUpperCase();\n');
    e.changed('src/sinter.helpers.js');
    await e.diagnostics('index.html', (d) => d.length === 0);
  });

  describe('types', () => {
    const TYPES = 'export interface Contact { id: number; name: string; tags: string[] }\n';
    const PAGE = (expr: string) => `<sn-resource name="contacts" src="/api/contacts" key="id" type="Contact[]"></sn-resource>
<ul>
  <template data-sn-for="c in contacts">
    <li data-sn-text="${expr}"></li>
  </template>
</ul>
`;

    test('type errors appear as you type and clear when fixed', async () => {
      const root = project({ 'src/sinter.types.ts': TYPES, 'index.html': PAGE('c.name') });
      const e = await editor(root);
      e.open('index.html', PAGE('c.nmae'));
      const d = await e.diagnostics('index.html', (d) => d.some((x) => x.code.startsWith('SN208')));
      const t = d.find((x) => x.code.startsWith('SN208'))!;
      expect(t.message).toContain("Property 'nmae' does not exist on type 'Contact'");
      expect(t.message).toContain('(TS2');
      // TypeScript's own range: the property name
      expect(t.range).toEqual({ start: { line: 3, character: 24 }, end: { line: 3, character: 28 } });
      e.change('index.html', PAGE('c.name.toUpperCase()'));
      await e.diagnostics('index.html', (d) => d.length === 0);
    });

    test('a type error in a partial is reported on the partial', async () => {
      const page = '<sn-resource name="contacts" src="/api/contacts" key="id" type="Contact[]"></sn-resource>\n<sn-include src="./row.html"></sn-include>\n';
      const row = '<template data-sn-for="c in contacts">\n  <p data-sn-text="c.tags.lenght"></p>\n</template>\n';
      const root = project({ 'src/sinter.types.ts': TYPES, 'index.html': page, 'row.html': row });
      const e = await editor(root);
      e.open('row.html', row);
      const d = await e.diagnostics('row.html', (d) => d.some((x) => x.code.startsWith('SN208')));
      expect(d.find((x) => x.code.startsWith('SN208'))!.message).toMatch(/Did you mean 'length'\?/);
      expect(e.current('index.html').filter((x) => x.code.startsWith('SN208'))).toEqual([]);
    });

    test('hover shows the type of a name in an expression', async () => {
      const root = project({ 'src/sinter.types.ts': TYPES, 'index.html': PAGE('c.name') });
      const e = await editor(root);
      e.open('index.html', PAGE('c.name'));
      await e.diagnostics('index.html');
      // on `name` in `c.name` (line 4, column 26)
      const h = await e.hover('index.html', 3, 25);
      expect(h!.contents.value).toContain('Contact.name: string');
      expect(h!.range).toEqual({ start: { line: 3, character: 24 }, end: { line: 3, character: 28 } });
      // outside expressions there is nothing to say
      expect(await e.hover('index.html', 1, 2)).toBeNull();
    });
  
    test('before TypeScript 7, type errors come from `tsc` on save', async () => {
      // a TypeScript 5 package whose `tsc` runs the real one
      const root = project({
        'src/sinter.types.ts': TYPES,
        'index.html': PAGE('c.name'),
        'old-ts/package.json': '{"name":"typescript","version":"5.9.3","bin":{"tsc":"bin/tsc"}}',
        'old-ts/bin/tsc': `const { spawnSync } = require('node:child_process');\nprocess.exitCode = spawnSync(process.execPath, [${JSON.stringify(tsc)}, ...process.argv.slice(2)], { stdio: 'inherit' }).status;\n`,
      });
      const e = await editor(root, { tsc: join(root, 'old-ts/bin/tsc') });
      e.open('index.html', PAGE('c.nmae'));
      await e.diagnostics('index.html');
      await new Promise((r) => setTimeout(r, 100));
      expect(e.current('index.html')).toEqual([]);
      writeFileSync(join(root, 'index.html'), PAGE('c.nmae'));
      e.save('index.html');
      const d = await e.diagnostics('index.html', (d) => d.length > 0);
      expect(d[0]!.message).toContain("Property 'nmae' does not exist on type 'Contact'");
    });
  });
});
