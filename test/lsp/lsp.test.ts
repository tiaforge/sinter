// The language server, driven over in-memory streams the way an editor drives it.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, describe, expect, test } from 'vitest';
import { Connection } from '../../src/lsp/rpc.js';
import { findTsc } from '../../src/check/index.js';
import { EXTRACT_FIX_CODES, componentAt, rangeOf, startServer, type LspDiagnostic } from '../../src/lsp/server.js';
import { typeFromHover } from '../../src/lsp/extract.js';
import { didYouMeanEdit, suggestionOf } from '../../src/lsp/quickfix.js';

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

interface Range { start: { line: number; character: number }; end: { line: number; character: number } }
interface TextEdit { range: Range; newText: string }
interface Action {
  title: string;
  kind: string;
  diagnostics?: LspDiagnostic[];
  data?: unknown;
  edit?: { changes?: Record<string, TextEdit[]>; documentChanges?: Array<{ kind?: string; uri?: string; textDocument?: { uri: string }; edits?: TextEdit[] }> };
}

const open: Connection[] = [];
afterEach(() => { for (const c of open.splice(0)) c.close(); });

/** A server and an editor-side connection to it, with the diagnostics it published per file. */
async function editor(root: string, options: { tsc?: string; capabilities?: object } = {}) {
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
  await client.request('initialize', { processId: null, rootUri: pathToFileURL(root).href, capabilities: options.capabilities ?? {} });
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
    completion(rel: string, line: number, character: number) {
      return client.request<{ items: Array<{ label: string; textEdit?: { range: unknown; newText: string }; data?: unknown }> } | null>('textDocument/completion', { textDocument: { uri: uri(rel) }, position: { line, character }, context: { triggerKind: 1 } });
    },
    resolve(item: unknown) {
      return client.request<{ detail?: string }>('completionItem/resolve', item);
    },
    definition(rel: string, line: number, character: number) {
      return client.request<Array<{ uri: string; range: { start: { line: number; character: number } } }> | null>('textDocument/definition', { textDocument: { uri: uri(rel) }, position: { line, character } });
    },
    codeActions(rel: string, diagnostics: LspDiagnostic[]) {
      return client.request<Array<{ title: string; edit: { changes: Record<string, Array<{ range: unknown; newText: string }>> } }>>('textDocument/codeAction', {
        textDocument: { uri: uri(rel) }, range: diagnostics[0]!.range, context: { diagnostics },
      });
    },
    /** the code actions for a selection, without diagnostics */
    actions(rel: string, range: Range, only?: string[]) {
      return client.request<Action[]>('textDocument/codeAction', {
        textDocument: { uri: uri(rel) }, range, context: { diagnostics: [], ...(only ? { only } : {}) },
      });
    },
    resolveAction(action: Action) {
      return client.request<Action>('codeAction/resolve', action);
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

  test('a component is checked through the pages that use it, and on its own when none does', async () => {
    const page = '<sn-resource name="contacts" src="/api/contacts" key="id"></sn-resource>\n<div data-sn-state="{ q: \'\' }">\n  <contact-list data-sn-prop="{ q }"></contact-list>\n</div>\n';
    const component = '<template data-sn-component="{ q: string }"><ul><template data-sn-for="c in contacts">\n  <p data-sn-text="c.name + q"></p>\n</template></ul></template>\n';
    const root = project({ 'index.html': page, 'src/components/contact-list.html': component, 'src/components/lone-card.html': '<template data-sn-component=""><p data-sn-text="nope"></p></template>\n' });
    const e = await editor(root);
    e.open('src/components/contact-list.html', component);
    // `contacts` is the page's resource and `q` a prop, so the component has no errors
    expect((await e.diagnostics('src/components/contact-list.html')).filter((x) => x.severity === 1)).toEqual([]);

    e.change('src/components/contact-list.html', component.replace('c.name + q', 'c.name + qq'));
    const d = await e.diagnostics('src/components/contact-list.html', (d) => d.some((x) => x.code.startsWith('SN201')));
    expect(d.find((x) => x.code.startsWith('SN201'))!.range.start).toEqual({ line: 1, character: 28 });
    // reported once, on the component, not on the page
    expect(e.current('index.html').filter((x) => x.severity === 1)).toEqual([]);

    e.change('src/components/contact-list.html', component);
    await e.diagnostics('src/components/contact-list.html', (d) => d.every((x) => x.severity === 2));

    e.open('src/components/lone-card.html', '<template data-sn-component=""><p data-sn-text="nope"></p></template>\n');
    const lone = await e.diagnostics('src/components/lone-card.html', (d) => d.length > 0);
    expect(lone.map((x) => x.code)).toEqual(['SN201 unknown-identifier']);
  });

  test('an HTML file that no page includes is compiled as a page', async () => {
    const root = project({ 'index.html': '<p>hi</p>\n' });
    const e = await editor(root);
    e.open('about.html', '<p data-sn-text="nope"></p>\n');
    const d = await e.diagnostics('about.html', (d) => d.length > 0);
    expect(d[0]!.code).toBe('SN201 unknown-identifier');
  });

  test('SN507 is published as a warning on the whole attribute', async () => {
    const root = project({ 'index.html': '<p>hi</p>\n' });
    const e = await editor(root);
    e.open('index.html', '<div data-sn-state="{ n: 0 }">\n  <button data-sn-on-click="n = 1; n = 2; n = 3; n = 4; n = 5" data-sn-text="n"></button>\n</div>\n');
    const [d] = await e.diagnostics('index.html', (d) => d.length === 1);
    expect(d!.code).toBe('SN507 complex-expression');
    expect(d!.severity).toBe(2);
    expect(d!.message).toMatch(/5 statements in one handler \(limit `statements`: 4\)/);
    expect(d!.range).toEqual({ start: { line: 1, character: 10 }, end: { line: 1, character: 62 } });
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

  test('a changed actions module reloads the project', async () => {
    const root = project({ 'index.html': '<p>hi</p>\n' });
    const e = await editor(root);
    e.open('index.html', '<button data-sn-call="archive(1)"></button>\n');
    const [d] = await e.diagnostics('index.html', (d) => d.some((x) => x.code.startsWith('SN310')));
    expect(d!.message).toContain('`archive` is not exported by the actions module');
    mkdirSync(join(root, 'src'), { recursive: true });
    writeFileSync(join(root, 'src/sinter.actions.js'), 'export const archive = async (id) => id;\n');
    e.changed('src/sinter.actions.js');
    await e.diagnostics('index.html', (d) => d.length === 0);
    writeFileSync(join(root, 'src/sinter.actions.js'), 'export const archived = async (id) => id;\n');
    e.changed('src/sinter.actions.js');
    const [again] = await e.diagnostics('index.html', (d) => d.some((x) => x.code.startsWith('SN310')));
    expect(again!.message).toContain('Did you mean `archived`?');
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

    test('a type error in a component is reported on the component', async () => {
      const page = '<sn-resource name="contacts" src="/api/contacts" key="id" type="Contact[]"></sn-resource>\n<contact-rows></contact-rows>\n';
      const row = '<template data-sn-component=""><ul><template data-sn-for="c in contacts">\n  <p data-sn-text="c.tags.lenght"></p>\n</template></ul></template>\n';
      const root = project({ 'src/sinter.types.ts': TYPES, 'index.html': page, 'src/components/contact-rows.html': row });
      const e = await editor(root);
      e.open('src/components/contact-rows.html', row);
      const d = await e.diagnostics('src/components/contact-rows.html', (d) => d.some((x) => x.code.startsWith('SN208')));
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

describe('did-you-mean', () => {
  test('finds the misspelled name next to the suggestion', () => {
    expect(suggestionOf('`contcts` is not defined here. Did you mean `contacts`?')).toEqual({ wrong: 'contcts', right: 'contacts' });
    expect(suggestionOf("Property 'titel' does not exist on type 'Article'. Did you mean 'title'?")).toEqual({ wrong: 'titel', right: 'title' });
    expect(suggestionOf('`m.inbox_titel` is not exported by namespace `m`. Did you mean `inbox_title`?')).toEqual({ wrong: 'inbox_titel', right: 'inbox_title' });
    expect(suggestionOf('`$meta.contacts.loadng` is not a status field. Did you mean `loading`?')).toEqual({ wrong: 'loadng', right: 'loading' });
    expect(suggestionOf('the response of `GET /articles` has no `articls`. Did you mean `articles`?')).toEqual({ wrong: 'articls', right: 'articles' });
    expect(suggestionOf('`data-sn-txt` is not a sinter attribute. Did you mean `data-sn-text`?')).toEqual({ wrong: 'data-sn-txt', right: 'data-sn-text' });
    expect(suggestionOf('no element `id="mark-raed"` on this page. Did you mean `mark-read`?')).toEqual({ wrong: 'mark-raed', right: 'mark-read' });
    expect(suggestionOf('no `<dialog id="compse">` on this page. Did you mean `compose`?')).toEqual({ wrong: 'compse', right: 'compose' });
    expect(suggestionOf('resource `x` is declared twice')).toBeNull();
  });

  test('replaces the whole name nearest the diagnostic', () => {
    const text = '<p data-sn-txt="txt"></p>';
    const range = { start: { line: 0, character: 3 }, end: { line: 0, character: 20 } };
    expect(didYouMeanEdit(text, range, '`data-sn-txt` is not a sinter attribute. Did you mean `data-sn-text`?')).toEqual({
      range: { start: { line: 0, character: 3 }, end: { line: 0, character: 14 } }, newText: 'data-sn-text',
    });
    // `cnt` inside `cnt2` is not the name
    const t2 = 'a cnt2 + cnt';
    expect(didYouMeanEdit(t2, { start: { line: 0, character: 9 }, end: { line: 0, character: 12 } }, '`cnt` is not defined here. Did you mean `count`?')!.range)
      .toEqual({ start: { line: 0, character: 9 }, end: { line: 0, character: 12 } });
  });
});

test('componentAt finds the tag name under the cursor', () => {
  const line = '  <article-preview data-sn-prop="{ a }"></article-preview>';
  expect(componentAt(line, 0, 5)).toBe('article-preview');
  expect(componentAt(line, 0, 45)).toBe('article-preview');
  expect(componentAt(line, 0, 25)).toBeNull();
});

describe('completion, definition, quick fixes', () => {
  const TYPES = 'export interface Contact {\n  id: number;\n  name: string;\n  tags: string[];\n}\n';
  const PAGE = (expr: string) => `<sn-resource name="contacts" src="/api/contacts" key="id" type="Contact[]"></sn-resource>
<div data-sn-state="{ query: '', open: false }">
  <template data-sn-for="(c, i) in contacts">
    <li data-sn-text="${expr}"></li>
  </template>
</div>
`;

  test('completes members, also in an expression that does not parse yet', async () => {
    const root = project({ 'src/sinter.types.ts': TYPES, 'index.html': PAGE('c.name') });
    const e = await editor(root);
    e.open('index.html', PAGE('c.'));
    await e.diagnostics('index.html', (d) => d.some((x) => x.code.startsWith('SN401')));
    const r = await e.completion('index.html', 3, 24);
    const labels = r!.items.map((i) => i.label);
    expect(labels).toEqual(expect.arrayContaining(['id', 'name', 'tags']));
    const resolved = await e.resolve(r!.items.find((i) => i.label === 'name'));
    expect(resolved.detail).toContain('string');
  });

  test('completes the status fields of $meta.<resource>, `live` among them, with its meaning on hover', async () => {
    const root = project({ 'src/sinter.types.ts': TYPES, 'index.html': PAGE('c.name') });
    const e = await editor(root);
    e.open('index.html', PAGE('$meta.contacts.'));
    await e.diagnostics('index.html', (d) => d.length > 0);
    const r = await e.completion('index.html', 3, 37);
    expect(r!.items.map((i) => i.label)).toEqual(expect.arrayContaining(['loading', 'error', 'loadedAt', 'pending', 'total', 'live']));
    const resolved = await e.resolve(r!.items.find((i) => i.label === 'live'));
    expect(JSON.stringify(resolved)).toContain('retrying');
  });

  test('completes names in scope, without the shadow\'s own', async () => {
    const root = project({ 'src/sinter.types.ts': TYPES, 'index.html': PAGE('c.name') });
    const e = await editor(root);
    e.open('index.html', PAGE('qu'));
    await e.diagnostics('index.html', (d) => d.length > 0);
    const labels = (await e.completion('index.html', 3, 24))!.items.map((i) => i.label);
    expect(labels).toEqual(expect.arrayContaining(['query', 'open', 'contacts', 'c', 'i', '$meta', 'date']));
    expect(labels.filter((l) => /^\$(any|item|p|e\d+)$/.test(l))).toEqual([]);
  });

  test('go to definition lands where the HTML declares a name', async () => {
    const root = project({ 'src/sinter.types.ts': TYPES, 'index.html': PAGE('c.name + query + contacts.length + i') });
    const e = await editor(root);
    e.open('index.html', PAGE('c.name + query + contacts.length + i'));
    await e.diagnostics('index.html');
    const at = async (character: number) => (await e.definition('index.html', 3, character))!.map((d) => [d.uri.split('/').pop(), d.range.start.line, d.range.start.character]);
    expect(await at(22)).toEqual([['index.html', 2, 26]]); // c → data-sn-for
    expect(await at(31)).toEqual([['index.html', 1, 22]]); // query → the state literal
    expect(await at(40)).toEqual([['index.html', 0, 19]]); // contacts → name="contacts"
    expect(await at(58)).toEqual([['index.html', 2, 29]]); // i → the index
    expect(await at(25)).toEqual([['sinter.types.ts', 2, 2]]); // name → the types module
  });

  test('go to definition of a type from OpenAPI opens the spec', async () => {
    const spec = `openapi: 3.0.0
info: { title: t, version: '1' }
paths:
  /api/contacts:
    get:
      responses:
        '200':
          content:
            application/json:
              schema:
                type: array
                items: { $ref: '#/components/schemas/Contact' }
components:
  schemas:
    Contact:
      type: object
      properties:
        id: { type: integer }
        name: { type: string }
`;
    const page = '<sn-resource name="contacts" src="/api/contacts" key="id"></sn-resource>\n<p data-sn-text="contacts[0].name"></p>\n';
    const root = project({ 'openapi.yml': spec, 'index.html': page, 'vite.config.js': `import sinter from ${JSON.stringify(join(process.cwd(), 'src/vite.ts'))};\nexport default { plugins: [sinter({ openapi: 'openapi.yml' })] };\n` });
    const e = await editor(root);
    e.open('index.html', page);
    await e.diagnostics('index.html');
    const d = await e.definition('index.html', 1, 30);
    expect(d!.map((x) => [x.uri.split('/').pop(), x.range.start.line, x.range.start.character])).toEqual([['openapi.yml', 18, 8]]);
  });

  test('completes `operation` with the spec\'s GET operations and hovers the URL it calls', async () => {
    const spec = `openapi: 3.0.0
info: { title: t, version: '1' }
servers:
  - url: https://api.example.com/v1
paths:
  /profiles/{username}:
    get:
      operationId: GetProfile
      summary: A profile
      parameters: [{ name: username, in: path, required: true }]
      responses: { '200': { description: ok } }
    post:
      operationId: FollowProfile
      responses: { '200': { description: ok } }
  /tags:
    get:
      responses: { '200': { description: ok } }
`;
    const page = '<sn-resource name="p" operation="GetProfile" params="{ username: $url.username }"></sn-resource>\n';
    const root = project({ 'openapi.yml': spec, 'index.html': page, 'vite.config.js': `import sinter from ${JSON.stringify(join(process.cwd(), 'src/vite.ts'))};\nexport default { plugins: [sinter({ openapi: 'openapi.yml' })] };\n` });
    const e = await editor(root);
    e.open('index.html', page);
    const items = (await e.completion('index.html', 0, 35))!.items;
    expect(items.map((i) => [i.label, (i as { detail?: string }).detail])).toEqual([
      ['GetProfile', 'GET https://api.example.com/v1/profiles/{username}'],
      ['GET /tags', 'GET https://api.example.com/v1/tags'],
    ]);
    expect(items[0]!.textEdit!.newText).toBe('GetProfile');
    const h = (await e.hover('index.html', 0, 35))!.contents.value;
    expect(h).toContain('**GET** `https://api.example.com/v1/profiles/{username}`');
    expect(h).toContain('Requested as `https://api.example.com/v1/profiles/{$url.username}`');
    expect(h).toContain('A profile');
    expect(h).toContain('From `openapi.yml`');
  });

  test('go to definition on a component\'s tag opens the component', async () => {
    const page = '<x-row></x-row>\n';
    const root = project({ 'index.html': page, 'src/components/x-row.html': '<template data-sn-component=""><p>row</p></template>\n' });
    const e = await editor(root);
    e.open('index.html', page);
    const d = await e.definition('index.html', 0, 3);
    expect(d![0]!.uri).toBe(e.uri('src/components/x-row.html'));
  });

  describe('layouts and slots', () => {
    const LAYOUT = `<!doctype html>
<html data-sn-layout="{ title?: string }">
<head>
  <meta charset="utf-8">
  <slot name="head"></slot>
  <slot name="seo"><meta name="robots" content="all"></slot>
</head>
<body>
  <main><slot></slot></main>
  <footer><slot name="footer">© me</slot></footer>
</body>
</html>
`;
    const files = {
      'src/layouts/site-layout.html': LAYOUT,
      'src/components/seo-tags.html': '<template data-sn-head="{ title?: string }"><title data-sn-text="title ?? \'x\'">x</title></template>\n',
      'src/components/x-card.html': '<template data-sn-component="{ n: number }"><div><slot name="side"></slot><slot></slot></div></template>\n',
    };

    test('slot="…" completes the layout\'s head slots on a head element, its body slots on the rest', async () => {
      const page = '<site-layout>\n  <meta slot="" name="x" content="y">\n  <p slot="">x</p>\n</site-layout>\n';
      const root = project({ ...files, 'index.html': page });
      const e = await editor(root);
      e.open('index.html', page);
      const head = await e.completion('index.html', 1, 14);
      expect(head!.items.map((i) => i.label)).toEqual(['head', 'seo']);
      expect(head!.items[0]!.textEdit!.newText).toBe('head');
      const body = await e.completion('index.html', 2, 11);
      expect(body!.items.map((i) => i.label)).toEqual(['footer']);
    });

    test('slot="…" completes a component\'s slots; go to definition lands on the <slot>', async () => {
      const page = '<div><x-card data-sn-prop="{ n: 1 }"><b slot="side">x</b></x-card></div>\n';
      const root = project({ ...files, 'index.html': page });
      const e = await editor(root);
      e.open('index.html', page);
      expect((await e.completion('index.html', 0, 47))!.items.map((i) => i.label)).toEqual(['side']);
      const d = await e.definition('index.html', 0, 47);
      expect(d!.map((x) => [x.uri.split('/').pop(), x.range.start.line, x.range.start.character])).toEqual([['x-card.html', 0, 49]]);
    });

    test('tags: layouts at the top of an empty page, head components in a head, components in a body', async () => {
      const root = project({ ...files, 'index.html': '<' });
      const e = await editor(root);
      e.open('index.html', '<');
      expect((await e.completion('index.html', 0, 1))!.items.map((i) => i.label)).toEqual(['site-layout']);
      const doc = '<!doctype html><html><head>\n  <\n</head><body>\n  <\n</body></html>\n';
      e.change('index.html', doc);
      expect((await e.completion('index.html', 1, 3))!.items.map((i) => i.label)).toEqual(['seo-tags']);
      expect((await e.completion('index.html', 3, 3))!.items.map((i) => i.label)).toEqual(['x-card']);
    });

    test('hover on a layout\'s tag lists its props and slots; go to definition opens the layout', async () => {
      const page = '<site-layout data-sn-prop="{ title: \'a\' }"><p>x</p></site-layout>\n';
      const root = project({ ...files, 'index.html': page });
      const e = await editor(root);
      e.open('index.html', page);
      const h = await e.hover('index.html', 0, 3);
      expect(h!.contents.value).toContain('**`<site-layout>`** layout · `src/layouts/site-layout.html`');
      expect(h!.contents.value).toContain('Props: `{ title?: string }`');
      expect(h!.contents.value).toMatch(/- `head` \(head\)\n- `seo` \(head\), with fallback\n- default \(body\)\n- `footer` \(body\), with fallback/);
      expect((await e.definition('index.html', 0, 3))![0]!.uri).toBe(e.uri('src/layouts/site-layout.html'));
    });

    test('a layout and a head component no page uses are checked on their own', async () => {
      const root = project({ ...files, 'index.html': '<p>x</p>\n' });
      const e = await editor(root);
      const bad = LAYOUT.replace('<main>', '<main data-sn-text="nope">');
      e.open('src/layouts/site-layout.html', bad);
      expect((await e.diagnostics('src/layouts/site-layout.html', (d) => d.length > 0)).map((x) => x.code)).toEqual(['SN201 unknown-identifier']);
      e.open('src/components/seo-tags.html', files['src/components/seo-tags.html']);
      expect((await e.diagnostics('src/components/seo-tags.html')).filter((x) => x.severity === 1)).toEqual([]);
    });
  });

  test('quick fixes apply the suggestion of compiler and type errors', async () => {
    const root = project({ 'src/sinter.types.ts': TYPES, 'index.html': PAGE('c.name') });
    const e = await editor(root);
    // an unknown attribute's value is not compiled, so the attribute typo has its own element
    e.open('index.html', PAGE('c.name + qeury').replace('</div>', '  <p data-sn-txt="query"></p>\n</div>'));
    const d = await e.diagnostics('index.html', (d) => d.length === 2 && d.some((x) => x.code.startsWith('SN101')));
    const fix = async (code: string) => {
      const diag = d.find((x) => x.code.startsWith(code))!;
      const [a] = await e.codeActions('index.html', [diag]);
      return a!.edit.changes[e.uri('index.html')]![0];
    };
    expect(await fix('SN101')).toEqual({ range: { start: { line: 5, character: 5 }, end: { line: 5, character: 16 } }, newText: 'data-sn-text' });
    expect(await fix('SN201')).toEqual({ range: { start: { line: 3, character: 31 }, end: { line: 3, character: 36 } }, newText: 'query' });
    // TypeScript suggests only close names (`nam`, not `nmae`)
    e.change('index.html', PAGE('c.nam'));
    const t = await e.diagnostics('index.html', (d) => d.some((x) => x.code.startsWith('SN208')));
    const [a] = await e.codeActions('index.html', t.filter((x) => x.code.startsWith('SN208')));
    expect(a!.edit.changes[e.uri('index.html')]![0]).toEqual({ range: { start: { line: 3, character: 24 }, end: { line: 3, character: 27 } }, newText: 'name' });
  });
});

/** The 0-based range of `needle` in `text` (its `n`th occurrence); `cursor`: an empty range at its start plus `cursor`. */
function find(text: string, needle: string, o: { cursor?: number; n?: number } = {}): Range {
  let at = -1;
  for (let k = 0; k <= (o.n ?? 0); k++) at = text.indexOf(needle, at + 1);
  if (at < 0) throw new Error(`no ${needle}`);
  const pos = (off: number) => {
    const before = text.slice(0, off).split('\n');
    return { line: before.length - 1, character: before[before.length - 1]!.length };
  };
  return o.cursor !== undefined ? { start: pos(at + o.cursor), end: pos(at + o.cursor) } : { start: pos(at), end: pos(at + needle.length) };
}

function applyEdits(text: string, edits: TextEdit[]): string {
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === '\n') starts.push(i + 1);
  const off = (p: { line: number; character: number }) => (starts[p.line] ?? text.length) + p.character;
  for (const e of [...edits].sort((a, b) => off(b.range.start) - off(a.range.start))) {
    text = text.slice(0, off(e.range.start)) + e.newText + text.slice(off(e.range.end));
  }
  return text;
}

/** Applies a workspace edit to the files on disk, as an editor does on save; returns the new texts by file name relative to `root`. */
function apply(root: string, edit: Action['edit']): Record<string, string> {
  const out: Record<string, string> = {};
  const write = (uri: string, edits: TextEdit[]) => {
    const path = fileURLToPath(uri);
    const text = applyEdits(existsSync(path) ? readFileSync(path, 'utf8') : '', edits);
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, text);
    out[path.slice(root.length + 1)] = text;
  };
  for (const [uri, edits] of Object.entries(edit?.changes ?? {})) write(uri, edits);
  for (const c of edit?.documentChanges ?? []) {
    if (c.kind === 'create') { const path = fileURLToPath(c.uri!); if (!existsSync(path)) { mkdirSync(join(path, '..'), { recursive: true }); writeFileSync(path, ''); } }
    else write(c.textDocument!.uri, c.edits!);
  }
  return out;
}

describe('extract to helper', () => {
  const TYPES = 'export interface Contact { id: number; name: string; tags: string[] }\n';
  const CREATE = { workspace: { workspaceEdit: { documentChanges: true, resourceOperations: ['create'] } } };
  const PAGE = `<sn-resource name="contacts" src="/api/contacts" key="id" type="Contact[]"></sn-resource>
<div data-sn-state="{ query: '', open: false }">
  <template data-sn-for="(c, i) in contacts">
    <li data-sn-text="c.name.toUpperCase() + ' (' + c.tags.join(', ') + ')'"></li>
    <button data-sn-on-click="query = c.name.trim() + i; open = !open">Pick</button>
  </template>
</div>
`;
  const extracts = (list: Action[]) => list.filter((a) => a.kind === 'refactor.extract');

  test('a value expression becomes a call of a new helper, typed by TypeScript (JS module, JSDoc)', async () => {
    const root = project({ 'src/sinter.types.ts': TYPES, 'src/sinter.helpers.js': 'export const shout = (s) => s.toUpperCase();\n', 'index.html': PAGE });
    const e = await editor(root);
    e.open('index.html', PAGE);
    await e.diagnostics('index.html');
    const list = extracts(await e.actions('index.html', find(PAGE, 'c.name.toUpperCase', { cursor: 3 })));
    expect(list.map((a) => a.title)).toEqual(['Extract to helper `textValue` in src/sinter.helpers.js']);
    const files = apply(root, list[0]!.edit);
    expect(files['index.html']).toContain(`<li data-sn-text="textValue(c)"></li>`);
    expect(files['src/sinter.helpers.js']).toBe(`export const shout = (s) => s.toUpperCase();

/**
 * @param {import('./sinter.types').Contact} c
 */
export function textValue(c) {
  return c.name.toUpperCase() + ' (' + c.tags.join(', ') + ')';
}
`);
    // the result builds and type-checks
    e.changed('src/sinter.helpers.js');
    e.change('index.html', files['index.html']!);
    await e.diagnostics('index.html', (d) => d.length === 0);
  });

  test('a selection inside the expression extracts just that part', async () => {
    const root = project({ 'src/sinter.types.ts': TYPES, 'src/sinter.helpers.js': '', 'index.html': PAGE });
    const e = await editor(root);
    e.open('index.html', PAGE);
    await e.diagnostics('index.html');
    const [a] = extracts(await e.actions('index.html', find(PAGE, "c.tags.join(', ')")));
    const files = apply(root, a!.edit);
    expect(files['index.html']).toContain(`data-sn-text="c.name.toUpperCase() + ' (' + textValue(c) + ')'"`);
    expect(files['src/sinter.helpers.js']).toContain("export function textValue(c) {\n  return c.tags.join(', ');\n}\n");
    // a selection that is not one expression (half of `+`) takes the smallest expression around it
    writeFileSync(join(root, 'index.html'), PAGE);
    const [b] = extracts(await e.actions('index.html', find(PAGE, "' (' + c.tags")));
    // (`textValue` is taken now: the module has it)
    expect(apply(root, b!.edit)['index.html']).toContain(`data-sn-text="textValue2(c) + ')'"`);
    // a plain name or member path is not worth a helper
    expect(extracts(await e.actions('index.html', find(PAGE, 'c.name', { n: 0 })))).toEqual([]);
  });

  test('in a handler, the assignment stays and its value is extracted', async () => {
    const root = project({ 'src/sinter.types.ts': TYPES, 'src/sinter.helpers.ts': '', 'index.html': PAGE });
    const e = await editor(root);
    e.open('index.html', PAGE);
    await e.diagnostics('index.html');
    const list = extracts(await e.actions('index.html', find(PAGE, 'query = c.name', { cursor: 10 })));
    expect(list.map((a) => a.title)).toEqual(['Extract to helper `nextQuery` in src/sinter.helpers.ts']);
    const files = apply(root, list[0]!.edit);
    expect(files['index.html']).toContain('data-sn-on-click="query = nextQuery(c, i); open = !open"');
    expect(files['src/sinter.helpers.ts']).toBe(`import type { Contact } from './sinter.types';

export function nextQuery(c: Contact, i: number) {
  return c.name.trim() + i;
}
`);
    // selecting the whole assignment extracts its value too
    writeFileSync(join(root, 'src/sinter.helpers.ts'), '');
    const [w] = extracts(await e.actions('index.html', find(PAGE, 'query = c.name.trim() + i')));
    expect(w!.title).toContain('`nextQuery`');
    // `open = !open` is not worth one, and a store call is not a helper
    expect(extracts(await e.actions('index.html', find(PAGE, 'open = !open', { cursor: 2 })))).toEqual([]);
    const refresh = PAGE.replace('open = !open', "refresh('contacts')");
    e.change('index.html', refresh);
    await e.diagnostics('index.html');
    expect(extracts(await e.actions('index.html', find(refresh, "refresh('contacts')")))).toEqual([]);
  });

  test('a handler writing several properties of one state object: one helper per value, or one returning an object', async () => {
    const page = `<div data-sn-state="{ draft: { title: '', body: '' }, sig: '-- me', note: '' }">
  <button data-sn-on-click="draft.title = draft.title.trim(); draft.body = draft.body.trim() + sig; close()">Tidy</button>
  <button data-sn-on-click="note = sig.trim(); draft.title = note.toUpperCase()">Other</button>
</div>
`;
    const root = project({ 'src/sinter.helpers.js': '', 'index.html': page });
    const e = await editor(root);
    e.open('index.html', page);
    await e.diagnostics('index.html');
    const sel = find(page, 'draft.title = draft.title.trim(); draft.body = draft.body.trim() + sig');
    const list = extracts(await e.actions('index.html', sel));
    expect(list.map((a) => a.title)).toEqual([
      'Extract 2 computed values to helpers (`nextTitle`, `nextBody`)',
      'Extract the 2 assignments to helper `draftChanges` (returns an object, merged with Object.assign)',
    ]);
    const values = apply(root, list[0]!.edit);
    expect(values['index.html']).toContain('data-sn-on-click="draft.title = nextTitle(draft); draft.body = nextBody(draft, sig); close()"');
    writeFileSync(join(root, 'index.html'), page);
    writeFileSync(join(root, 'src/sinter.helpers.js'), '');
    const merged = apply(root, list[1]!.edit);
    expect(merged['index.html']).toContain('data-sn-on-click="Object.assign(draft, draftChanges(draft, sig)); close()"');
    expect(merged['src/sinter.helpers.js']).toContain(`export function draftChanges(draft, sig) {
  return {
    title: draft.title.trim(),
    body: draft.body.trim() + sig,
  };
}`);
    e.changed('src/sinter.helpers.js');
    e.change('index.html', merged['index.html']!);
    await e.diagnostics('index.html', (d) => d.length === 0);
    // the second handler writes two roots, and its second value reads the first: values only
    const other = extracts(await e.actions('index.html', find(page, 'note = sig.trim(); draft.title = note.toUpperCase()')));
    expect(other.map((a) => a.title)).toEqual(['Extract 2 computed values to helpers (`nextNote`, `nextTitle`)']);
  });

  test('free names: loop variables, state, resources, magic names and locals become parameters; helpers and globals do not', async () => {
    const page = `<sn-resource name="contacts" src="/api/contacts" key="id" type="Contact[]"></sn-resource>
<div data-sn-state="{ query: '', note: '' }">
  <template data-sn-for="c in contacts">
    <button data-sn-on-click="note = shout(c.name) + query + $event.button + $el.tagName + $meta.contacts.total + date($now) + Math.max(1, contacts.length) + c.tags.map((t) => t + query).join()">x</button>
  </template>
</div>
`;
    const root = project({ 'src/sinter.types.ts': TYPES, 'src/sinter.helpers.ts': 'export const shout = (s: string) => s.toUpperCase();\n', 'index.html': page });
    const e = await editor(root);
    e.open('index.html', page);
    await e.diagnostics('index.html');
    const [a] = extracts(await e.actions('index.html', find(page, 'note = shout', { cursor: 1 })));
    const files = apply(root, a!.edit);
    expect(files['index.html']).toContain('data-sn-on-click="note = nextNote(c, query, $event, $el, $meta.contacts, $now, contacts)"');
    const mod = files['src/sinter.helpers.ts']!;
    expect(mod).toContain(`export function nextNote(c: Contact, query: string, $event: PointerEvent, $el: HTMLButtonElement, contactsMeta: Meta, $now: Date, contacts: Contact[]) {
  return shout(c.name) + query + $event.button + $el.tagName + contactsMeta.total + date($now) + Math.max(1, contacts.length) + c.tags.map((t) => t + query).join();
}`);
    expect(mod).toContain("import type { Contact } from './sinter.types';");
    expect(mod).toContain("import type { Meta } from '@tiaforge-ui/sinter';");
    expect(mod).toContain("import { date } from '@tiaforge-ui/sinter';");
    // a part that uses an arrow function's parameter takes it as one
    writeFileSync(join(root, 'src/sinter.helpers.ts'), 'export const shout = (s: string) => s.toUpperCase();\n');
    writeFileSync(join(root, 'index.html'), page);
    const [b] = extracts(await e.actions('index.html', find(page, 't + query')));
    const sub = apply(root, b!.edit);
    expect(sub['index.html']).toContain('c.tags.map((t) => nextNote(t, query)).join()');
    expect(sub['src/sinter.helpers.ts']).toContain('export function nextNote(t: string, query: string) {');
  });

  test('without TypeScript 7 the parameters are `unknown`', async () => {
    const root = project({
      'src/sinter.types.ts': TYPES, 'src/sinter.helpers.ts': '', 'index.html': PAGE,
      'old-ts/package.json': '{"name":"typescript","version":"5.9.3","bin":{"tsc":"bin/tsc"}}',
      'old-ts/bin/tsc': 'process.exitCode = 0;\n',
    });
    const e = await editor(root, { tsc: join(root, 'old-ts/bin/tsc') });
    e.open('index.html', PAGE);
    await e.diagnostics('index.html');
    const [a] = extracts(await e.actions('index.html', find(PAGE, 'query = c.name', { cursor: 10 })));
    expect(apply(root, a!.edit)['src/sinter.helpers.ts']).toBe('export function nextQuery(c: unknown, i: unknown) {\n  return c.name.trim() + i;\n}\n');
  });

  test('a missing helpers module is created: .ts in a TypeScript project, .js otherwise', async () => {
    const ts = project({ 'src/sinter.types.ts': TYPES, 'index.html': PAGE });
    const e = await editor(ts, { capabilities: CREATE });
    e.open('index.html', PAGE);
    await e.diagnostics('index.html');
    const [a] = extracts(await e.actions('index.html', find(PAGE, 'c.name.toUpperCase', { cursor: 3 })));
    expect(a!.title).toBe('Extract to helper `textValue` in src/sinter.helpers.ts');
    expect(a!.edit!.documentChanges![0]).toEqual({ kind: 'create', uri: e.uri('src/sinter.helpers.ts'), options: { ignoreIfExists: true } });
    expect(apply(ts, a!.edit)['src/sinter.helpers.ts']).toBe(`import type { Contact } from './sinter.types';

export function textValue(c: Contact) {
  return c.name.toUpperCase() + ' (' + c.tags.join(', ') + ')';
}
`);
    const plain = '<div data-sn-state="{ n: 2 }"><p data-sn-text="n * 2 + 1"></p></div>\n';
    const js = project({ 'index.html': plain });
    const j = await editor(js, { capabilities: CREATE });
    j.open('index.html', plain);
    await j.diagnostics('index.html');
    const [b] = extracts(await j.actions('index.html', find(plain, 'n * 2', { cursor: 0 })));
    expect(apply(js, b!.edit)['src/sinter.helpers.js']).toBe('/**\n * @param {number} n\n */\nexport function textValue(n) {\n  return n * 2 + 1;\n}\n');
    // a configured path is used as it is
    const conf = project({ 'index.html': plain, 'vite.config.js': `import sinter from ${JSON.stringify(join(process.cwd(), 'src/vite.ts'))};\nexport default { plugins: [sinter({ helpers: 'lib/helpers.js' })] };\n` });
    const k = await editor(conf, { capabilities: CREATE });
    k.open('index.html', plain);
    await k.diagnostics('index.html');
    const [c] = extracts(await k.actions('index.html', find(plain, 'n * 2', { cursor: 0 })));
    expect(c!.title).toBe('Extract to helper `textValue` in lib/helpers.js');
    // a client that cannot create files is not offered one that needs a new module
    const none = project({ 'index.html': plain });
    const n = await editor(none);
    n.open('index.html', plain);
    await n.diagnostics('index.html');
    expect(extracts(await n.actions('index.html', find(plain, 'n * 2', { cursor: 0 })))).toEqual([]);
  });

  test('the name is unique: helpers, state and the module\'s own declarations are taken', async () => {
    const page = '<div data-sn-state="{ n: 2, textValue2: 0 }"><p data-sn-text="n * 2 + textValue2"></p></div>\n';
    const root = project({ 'src/sinter.helpers.js': 'export const textValue = (x) => x;\nconst textValue3 = 1;\n', 'index.html': page });
    const e = await editor(root);
    e.open('index.html', page);
    await e.diagnostics('index.html');
    const [a] = extracts(await e.actions('index.html', find(page, 'n * 2', { cursor: 0 })));
    expect(a!.title).toBe('Extract to helper `textValue4` in src/sinter.helpers.js');
  });

  test('what the compiler would reject is not offered: a state literal, a `data-sn-attr` object', async () => {
    const page = '<div data-sn-state="{ n: [1, 2].length }"><p data-sn-attr="{ title: n + 1 }"></p></div>\n';
    const root = project({ 'src/sinter.helpers.js': '', 'index.html': page });
    const e = await editor(root);
    e.open('index.html', page);
    await e.diagnostics('index.html');
    expect(extracts(await e.actions('index.html', find(page, '{ n: [1', { cursor: 1 })))).toEqual([]);
    expect(extracts(await e.actions('index.html', find(page, '{ title', { cursor: 1 })))).toEqual([]);
    // the values inside them are fine
    const [a] = extracts(await e.actions('index.html', find(page, '[1, 2].length')));
    expect(a!.title).toBe('Extract to helper `stateValue` in src/sinter.helpers.js');
    const [b] = extracts(await e.actions('index.html', find(page, 'n + 1')));
    expect(apply(root, b!.edit)['index.html']).toContain('data-sn-attr="{ title: attrValue(n) }"');
  });

  test('extract to action: a `data-sn-call` becomes a call of a new action that makes it', async () => {
    const page = `<div data-sn-state="{ draft: { to: '', body: '' }, sig: '' }">
  <button data-sn-call="send(wrap(draft.body, sig), draft.to)">Send</button>
</div>
`;
    const root = project({
      'src/sinter.helpers.js': 'export const wrap = (b, s) => b + s;\n',
      'src/sinter.actions.js': 'export async function send(body, to, ctx) {\n  return ctx.request(`/send?to=${to}`, { method: \'POST\', body });\n}\n',
      'index.html': page,
    });
    const e = await editor(root);
    e.open('index.html', page);
    await e.diagnostics('index.html');
    const list = extracts(await e.actions('index.html', find(page, 'send(', { cursor: 1 })));
    expect(list.map((a) => a.title)).toEqual(['Extract to action `runSend` in src/sinter.actions.js']);
    const files = apply(root, list[0]!.edit);
    expect(files['index.html']).toContain('data-sn-call="runSend(draft, sig)"');
    expect(files['src/sinter.actions.js']).toBe(`import { wrap } from './sinter.helpers';

export async function send(body, to, ctx) {
  return ctx.request(\`/send?to=\${to}\`, { method: 'POST', body });
}

/**
 * @param {{ to: string; body: string; }} draft
 * @param {string} sig
 * @param {import('@tiaforge-ui/sinter').CallContext} ctx
 */
export function runSend(draft, sig, ctx) {
  return send(wrap(draft.body, sig), draft.to, ctx);
}
`);
    e.changed('src/sinter.actions.js');
    e.change('index.html', files['index.html']!);
    await e.diagnostics('index.html', (d) => d.length === 0);
    // an argument is a value expression: it can be a helper instead
    writeFileSync(join(root, 'index.html'), page);
    e.change('index.html', page);
    await e.diagnostics('index.html', (d) => d.length > 0 || true);
    const inArg = extracts(await e.actions('index.html', find(page, 'wrap(draft', { cursor: 6 })));
    expect(inArg.map((a) => a.title)).toEqual(expect.arrayContaining(['Extract to helper `callValue` in src/sinter.helpers.js']));
  });

  test('in a component, the names are its props and the page\'s resources', async () => {
    const page = '<sn-resource name="contacts" src="/api/contacts" key="id" type="Contact[]"></sn-resource>\n<div data-sn-state="{ q: \'\' }">\n  <contact-rows data-sn-prop="{ q }"></contact-rows>\n</div>\n';
    const row = '<template data-sn-component="{ q: string }"><ul><template data-sn-for="c in contacts">\n  <p data-sn-show="c.name.includes(q)"></p>\n</template></ul></template>\n';
    const root = project({ 'src/sinter.types.ts': TYPES, 'src/sinter.helpers.ts': '', 'index.html': page, 'src/components/contact-rows.html': row });
    const e = await editor(root);
    e.open('src/components/contact-rows.html', row);
    await e.diagnostics('src/components/contact-rows.html');
    const [a] = extracts(await e.actions('src/components/contact-rows.html', find(row, 'c.name.includes', { cursor: 0 })));
    const files = apply(root, a!.edit);
    expect(files['src/components/contact-rows.html']).toContain('data-sn-show="showValue(c, q)"');
    expect(files['src/sinter.helpers.ts']).toContain('export function showValue(c: Contact, q: string) {\n  return c.name.includes(q);\n}');
  });

  test('a client with code action resolve gets the edit when it picks the action', async () => {
    const root = project({ 'src/sinter.types.ts': TYPES, 'src/sinter.helpers.ts': '', 'index.html': PAGE });
    const e = await editor(root, { capabilities: { textDocument: { codeAction: { resolveSupport: { properties: ['edit'] } } } } });
    e.open('index.html', PAGE);
    await e.diagnostics('index.html');
    const [a] = extracts(await e.actions('index.html', find(PAGE, 'query = c.name', { cursor: 10 })));
    expect(a!.edit).toBeUndefined();
    const r = await e.resolveAction(a!);
    expect(apply(root, r.edit)['src/sinter.helpers.ts']).toContain('export function nextQuery(c: Contact, i: number) {');
    // `only` without refactorings leaves them out
    expect(await e.actions('index.html', find(PAGE, 'query = c.name', { cursor: 10 }), ['quickfix'])).toEqual([]);
  });

  test('SN507 (complex expression) gets the extraction as a quick fix', async () => {
    const page = '<div data-sn-state="{ n: 0 }"><p data-sn-text="n === 0 ? \'none\' : n === 1 ? \'one\' : n === 2 ? \'two\' : \'many\'"></p></div>\n';
    const root = project({ 'src/sinter.helpers.js': '', 'index.html': page });
    const e = await editor(root);
    e.open('index.html', page);
    const d = await e.diagnostics('index.html', (d) => d.some((x) => x.code.startsWith('SN507')));
    expect(EXTRACT_FIX_CODES.has('SN507')).toBe(true);
    const fixes = (await e.codeActions('index.html', d.filter((x) => x.code.startsWith('SN507')))) as Action[];
    const fix = fixes.find((a) => a.kind === 'quickfix' && a.title.startsWith('Extract'))!;
    expect(fix.title).toBe('Extract to helper `textValue` in src/sinter.helpers.js');
    expect(fix.diagnostics![0]!.code).toMatch(/^SN507/);
    expect(apply(root, fix.edit)['index.html']).toBe('<div data-sn-state="{ n: 0 }"><p data-sn-text="textValue(n)"></p></div>\n');
  });

  test('diagnostics outside EXTRACT_FIX_CODES get no extraction quick fix', async () => {
    const page = "<p data-sn-text=\"'at ' + Date.now()\"></p>\n";
    const root = project({ 'src/sinter.helpers.js': '', 'index.html': page });
    const e = await editor(root);
    e.open('index.html', page);
    const d = await e.diagnostics('index.html', (d) => d.some((x) => x.code.startsWith('SN502')));
    const fixes = (await e.codeActions('index.html', d.filter((x) => x.code.startsWith('SN502')))) as Action[];
    expect(fixes.filter((a) => a.kind === 'quickfix' && a.title.startsWith('Extract'))).toEqual([]);
  });
});

test('typeFromHover reads the type of a declaration and widens literals', () => {
  expect(typeFromHover('let query: string')).toBe('string');
  expect(typeFromHover('const i: 0')).toBe('number');
  expect(typeFromHover('const s: "a"')).toBe('string');
  expect(typeFromHover('(property) contacts: Meta')).toBe('Meta');
  expect(typeFromHover('const c: Contact')).toBe('Contact');
  expect(typeFromHover('function shout(s: string): string')).toBeNull();
});
