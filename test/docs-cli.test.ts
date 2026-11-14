// `sinter docs`: parts of the llms.txt and docs/diagnostics.md that ship in the package, for coding agents
// that would otherwise read all of llms.txt again for one thing.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, test } from 'vitest';
import { lookup, sections } from '../src/docs-cli.js';

const root = resolve(__dirname, '..');
const docs = { llms: readFileSync(resolve(root, 'llms.txt'), 'utf8'), diagnostics: readFileSync(resolve(root, 'docs/diagnostics.md'), 'utf8') };
const get = (t?: string) => lookup(docs, t);

test('without a topic: every section, by slug', () => {
  const r = get();
  for (const s of sections(docs.llms)) expect(r.text).toContain(s.slug);
  expect(r.text).toMatch(/^\s+layouts\s+Layouts$/m);
});

test('a section by its slug or a word of it; a ## section with its ### children, and nothing after', () => {
  const layouts = get('layouts').text;
  expect(layouts.startsWith('## Layouts\n')).toBe(true);
  expect(layouts).not.toContain('## What belongs in markup');
  expect(get('Layouts').text).toBe(layouts);
  expect(get('first paint').text.startsWith('## First paint\n')).toBe(true);
  expect(get('optimistic-toggle').text).toMatch(/^### Optimistic toggle\n\n```html/);
  expect(get('recipes').text).toContain('### Optimistic toggle');
});

test('an attribute or element: its reference line and where else it is used', () => {
  const r = get('data-sn-optimistic').text;
  expect(r).toMatch(/^- `data-sn-optimistic` \(handler expression\): /);
  expect(r).toContain('sinter docs optimistic-toggle');
  expect(get('sn-event').text).toMatch(/^- `<sn-event>` `name`/);
});

test('a diagnostic: its explanation from docs/diagnostics.md', () => {
  const r = get('sn318');
  expect(r.found).toBe(true);
  expect(r.text).toMatch(/^## SN318 invalid-layout\n/);
  expect(r.text).toContain('data-sn-layout="{}"');
  expect(r.text).not.toContain('## SN319');
  expect(get('SN999').found).toBe(false);
});

test('words: the lines that have all of them, under their section', () => {
  const r = get('optimistic rolled back').text;
  expect(r).toContain('## Expressions and scope (sinter docs expressions-and-scope)');
  expect(get('zzz-nothing').found).toBe(false);
});

test('the CLI prints it from the files beside dist/', () => {
  const out = execFileSync(process.execPath, [resolve(root, 'node_modules/jiti/lib/jiti-cli.mjs'), resolve(root, 'src/cli.ts'), 'docs', 'SN318'], { encoding: 'utf8' });
  expect(out).toMatch(/^## SN318 invalid-layout/);
});
