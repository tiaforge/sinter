// The components' dispatch: block content is dispatched in one place (md-block) and phrasing content
// other than text in one place (md-phrasing), each a map from a node's `type` to its component. These
// checks keep the maps, the types and the files in step, so a new node type cannot be missed in one of
// them (README.md, "Adding a node type").
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { PKG } from './app.js';

const DIR = join(PKG, 'sinter/components');
const files = [...readdirSync(DIR).filter((f) => f.endsWith('.html')).map((f) => join(DIR, f)), ...readdirSync(join(DIR, 'internal')).map((f) => join(DIR, 'internal', f))];
const read = (f: string) => readFileSync(f, 'utf8');
const TYPES = read(join(PKG, 'sinter/sinter.types.ts'));

/** the `type` literals of a union in sinter.types.ts (`export type Inline = Text | Emphasis | …`) */
function typesOf(union: string): string[] {
  const members = new RegExp(`export type ${union} = ([^;]+);`).exec(TYPES)![1]!.split('|').map((s) => s.trim());
  return members.map((m) => new RegExp(`export interface ${m} \\{\\s*type: '([^']+)'`).exec(TYPES)![1]!).sort();
}
/** the map of the one `<sn-component use>` in a component file */
function mapOf(name: string): Record<string, string> {
  const use = /<sn-component use="\{ ([^}]*) \}\[node\.type\]"/.exec(read(join(DIR, 'internal', `${name}.html`)))![1]!;
  return Object.fromEntries(use.split(', ').map((e) => e.split(': ')).map(([k, v]) => [k!, v!.slice(1, -1)]));
}

test('only md-block and md-phrasing choose a component: every other loop renders them', () => {
  const choosing = files.filter((f) => read(f).includes('<sn-component use=')).map((f) => f.slice(DIR.length + 1)).sort();
  expect(choosing).toEqual(['internal/md-block.html', 'internal/md-phrasing.html']);
});

test('md-block maps every block type, md-phrasing every inline type but text, each to a component that exists', () => {
  const block = mapOf('md-block'), phrasing = mapOf('md-phrasing');
  expect(Object.keys(block).sort()).toEqual(typesOf('Block'));
  expect(Object.keys(phrasing).sort()).toEqual(typesOf('Inline').filter((t) => t !== 'text'));
  for (const c of [...Object.values(block), ...Object.values(phrasing)]) expect(files.map((f) => f.split('/').pop())).toContain(`${c}.html`);
});

test('every loop over phrasing content renders text runs itself, and passes every other node to md-phrasing', () => {
  const RUN = /<template data-sn-for="n in ([^"]+)"><template data-sn-if="n\.type === 'text'"><template data-sn-text="n\.value"><\/template><\/template><template data-sn-else><md-phrasing data-sn-with="\{ node: n \}"><\/md-phrasing><\/template><\/template>/g;
  let loops = 0;
  for (const f of files) {
    const src = read(f);
    const runs = [...src.matchAll(RUN)].length;
    loops += runs;
    // no other way of reaching md-phrasing
    expect((src.match(/<md-phrasing /g) ?? []).length, f).toBe(runs);
  }
  expect(loops).toBeGreaterThan(0);
});
