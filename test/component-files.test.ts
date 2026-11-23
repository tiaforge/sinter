// Where a component's files are (src/component-files.ts): `<tag>.html`, or `<tag>/<tag>.html` in a folder of its own.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, expect, test } from 'vitest';
import { componentHtml, componentOfFile, componentOfPath, findComponents } from '../src/component-files.js';

const dir = mkdtempSync(join(tmpdir(), 'sinter-component-files-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const write = (rel: string, text = '<template><p></p></template>') => { mkdirSync(join(dir, rel, '..'), { recursive: true }); writeFileSync(join(dir, rel), text); };

test('a path names a component when it is `<tag>.html` or `<tag>/<tag>.html`', () => {
  expect(componentOfPath('task-ring.html')).toBe('task-ring');
  expect(componentOfPath('task-ring/task-ring.html')).toBe('task-ring');
  expect(componentOfPath('task-ring/ring-legend.html')).toBeNull();
  expect(componentOfPath('forms/text-input.html')).toBeNull();
  expect(componentOfPath('a/task-ring/task-ring.html')).toBeNull();
  expect(componentOfPath('card.html')).toBeNull();
  expect(componentOfPath('task-ring/task-ring.ts')).toBeNull();
});

test('found in both forms, with the folder\'s modules and the skipped folders left alone; misplaced HTML is SN349', () => {
  write('x-flat.html');
  write('x-own/x-own.html');
  write('x-own/x-own.ts', 'export default class {}');
  write('x-own/math.ts', 'export const x = 1;');
  write('x-own/x-extra.html');
  write('x-both.html');
  write('x-both/x-both.html');
  write('forms/text-input.html');
  write('shared/util.ts', 'export {}');
  write('internal/x-inner.html');
  const f = findComponents(dir, ['internal']);
  expect(f.names).toEqual(['x-both', 'x-flat', 'x-own']);
  expect(f.files.get('x-own')).toBe(join(dir, 'x-own/x-own.html'));
  expect(f.files.get('x-both')).toBe(join(dir, 'x-both.html'));
  expect(f.problems.map((p) => [p.code, p.file.slice(dir.length + 1)])).toEqual([
    ['SN349', 'forms/text-input.html'],
    ['SN349', 'x-both/x-both.html'],
    ['SN349', 'x-own/x-extra.html'],
  ]);
  expect(componentHtml(dir, 'x-own')).toBe(join(dir, 'x-own/x-own.html'));
  expect(componentHtml(dir, 'x-flat')).toBe(join(dir, 'x-flat.html'));
  expect(componentHtml(dir, 'x-none')).toBeNull();
  expect(componentOfFile([dir], join(dir, 'x-own/x-own.html'))).toBe('x-own');
  expect(componentOfFile([dir], join(dir, 'x-own/x-extra.html'))).toBeNull();
  expect(componentOfFile([join(dir, 'elsewhere')], join(dir, 'x-flat.html'))).toBeNull();
});
