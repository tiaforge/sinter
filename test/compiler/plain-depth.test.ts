// A helper's result, a let or a prop is a build-time constant when it is plain data, however deep it nests,
// up to a bound that keeps a cycle from being walked forever: a component library's constant tree (an
// email, a document) is as deep as its content. There used to be a bound of 20 levels, about 9 nested
// elements of such a tree.
import { expect, test } from 'vitest';
import { compile } from '../../src/compiler/index.js';

/** a page whose text reads the innermost value of `deep()`, a helper that folds, `depth` objects deep */
const build = (depth: number) => {
  let t: unknown = 'deep';
  for (let i = 0; i < depth; i++) t = { a: t };
  const path = Array.from({ length: depth }, () => 'a').join('.');
  return compile(`<!doctype html><html><head></head><body><p data-sn-text="deep().${path}"></p></body></html>`, {
    file: '/p/index.html', root: '/p', dev: false, prerender: true,
    helpers: { module: '/src/sinter.helpers.ts', names: ['deep'], namespaces: {} },
    readFile: () => { throw new Error('no files'); },
    helperValues: { deep: () => t }, helperFold: new Map([['deep', { fold: true }]]),
  });
};

test('a result 600 levels deep is a build-time constant', () => {
  const out = build(600);
  expect(out.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
  expect(out.html).toContain('<p>deep</p>');
});

test('past the bound it stays the browser\'s', () => {
  const out = build(1100);
  expect(out.html).not.toContain('<p>deep</p>');
});
