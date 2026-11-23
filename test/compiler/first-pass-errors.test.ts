// An error the first pass finds in the page's markup is reported, wherever it is: in a branch the build decides
// away (`data-sn-if="false"`), which the second pass does not compile, too. It is what keeps the page from unrolling
// its loops over constants (a clean first pass, docs/spec.md "Build-time constants"), so it must be what the page
// reports (redesign-notes/bugs.md, bug 6).
import { describe, expect, test } from 'vitest';
import { compile } from '../../src/compiler/index.js';

const run = (body: string) => compile(`<!doctype html><html><head></head><body>${body}</body></html>`, {
  file: '/p/index.html', root: '/p', dev: false, prerender: true,
  helpers: { module: null, names: [], namespaces: {} }, readFile: () => { throw new Error('missing'); },
});
const errors = (out: ReturnType<typeof run>) => out.diagnostics.filter((d) => d.severity === 'error').map((d) => `${d.code} ${d.line}:${d.col}`);
const LOOP = '<ul><template data-sn-for="x in [1, 2]"><li data-sn-text="x"></li></template></ul>';

describe('an error in markup the build decides away', () => {
  test('in `data-sn-if="false"`: reported at its place, once', () => {
    const out = run(`<template data-sn-if="false"><p data-sn-text="nope"></p></template>${LOOP}`);
    expect(errors(out)).toEqual([expect.stringMatching(/^SN201 1:\d+$/)]);
    expect(out.diagnostics.find((d) => d.code === 'SN201')!.message).toMatch(/`nope` is not defined here/);
  });

  test('in the `data-sn-else` of a branch decided true, and with no loop on the page', () => {
    const out = run('<template data-sn-if="true"><p>a</p></template><template data-sn-else><p data-sn-text="nope"></p></template>');
    expect(errors(out)).toEqual([expect.stringMatching(/^SN201 /)]);
  });

  test('the same error in a branch that renders: reported once, as before', () => {
    const out = run(`<template data-sn-if="true"><p data-sn-text="nope"></p></template>${LOOP}`);
    expect(errors(out)).toEqual([expect.stringMatching(/^SN201 /)]);
  });

  test('no error: the loop unrolls, as before', () => {
    const out = run(`<template data-sn-if="false"><p data-sn-text="1"></p></template>${LOOP}`);
    expect(errors(out)).toEqual([]);
    expect(out.html).toContain('<ul><li>1</li><li>2</li></ul>');
  });
});
