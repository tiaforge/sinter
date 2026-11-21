// Content namespaces in the compiler (docs/proposals/messages.md §1): nested ids, folding, the page module's code.
import { expect, test } from 'vitest';
import { compile, type CompileOptions } from '../../src/compiler/index.js';

const entries = { 'inbox.title': { t: 'Inbox' }, 'inbox.unread': { t: '{n} unread' }, plain: { t: 'Plain' } };
const formatFn = (e: unknown, a: unknown) => (e as { t: string }).t.replace('{n}', String((a as { n?: number } | undefined)?.n ?? ''));
const opts: CompileOptions = {
  file: '/app/index.html', root: '/app', dev: false, prerender: true, moduleSrc: '/m.js', readFile: () => '',
  helpers: { module: null, names: [], namespaces: { m: { module: 'sinter:content/m', members: Object.keys(entries).sort() } } },
  contentNs: { m: { entries, format: '/src/fmt.ts', formatFn } },
};

test('a nested id is one entry: folded over constants, compiled over data with its entry alone', () => {
  const out = compile('<sn-resource name="inbox" src="/api/inbox"></sn-resource><h1 data-sn-text="m.inbox.title()"></h1><p data-sn-text="m.inbox.unread({ n: inbox.n })"></p>', opts);
  expect(out.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
  expect(out.html).toContain('>Inbox</h1>');
  expect(out.module).toContain('import { format as $fmt$m } from "/src/fmt.ts";');
  expect(out.module).toContain('m$inbox$$unread = (p) => $fmt$m({"t":"{n} unread"}, p, null)');
  expect(out.module).not.toContain('"Inbox"');
});

test('a group or a typo in a nested id is SN206, with the ids that start like it', () => {
  const d = (x: string) => compile(`<p data-sn-text="${x}"></p>`, opts).diagnostics.filter((e) => e.code === 'SN206').map((e) => e.message);
  expect(d('m.inbox()')).toEqual([expect.stringMatching(/`m\.inbox` is not .*namespace `m`/)]);
  expect(d('m.inbox.titel()')).toEqual([expect.stringMatching(/`m\.inbox\.titel` is not an entry of namespace `m`.*inbox\.title/)]);
  expect(d('m.plain()')).toEqual([]);
});
