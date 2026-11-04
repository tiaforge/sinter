import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, test } from 'vitest';
import { compile } from '../../src/compiler/index.js';

const root = resolve(__dirname, '../fixtures');
const opts = (file: string) => ({
  file: `${root}/${file}`, root, dev: false,
  readFile: (p: string) => readFileSync(p, 'utf8'),
  helpers: { module: null, names: [], namespaces: {} },
});

test('contacts example compiles cleanly', () => {
  const out = compile(readFileSync(`${root}/contacts.html`, 'utf8'), opts('contacts.html'));
  console.log(out.html);
  console.log(out.module);
  expect(out.diagnostics).toEqual([]);
});
