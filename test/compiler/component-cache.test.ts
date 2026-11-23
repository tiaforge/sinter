// A build's component files, read and kinded once for all its compiles (`componentCache`, src/vite.ts passes one per
// build and clears it with the build's reads; test/vite/build-caches.test.ts has the rebuild under --watch): each
// compile gets a copy of its own, the same as reading the files itself would give, and the same output.
import { describe, expect, test } from 'vitest';
import { compile, type CompileOptions } from '../../src/compiler/index.js';

const page = (body: string) => `<!doctype html><html><head></head><body>${body}</body></html>`;
const FILES: Record<string, string> = {
  '/p/src/components/site-card.html': '<template data-sn-props="{ title: string }"><article><site-title data-sn-with="{ title }"></site-title><slot></slot></article></template>',
  '/p/src/components/site-title.html': '<template data-sn-props="{ title: string }"><h2 data-sn-text="title"></h2></template>',
  '/p/src/components/site-meta.html': '<template data-sn-props="{ name: string }"><meta name="x" data-sn-attr="{ content: name }"></template>',
  '/p/src/components/site-broken.html': '<template data-sn-props><b>one</b></template><template><i>two</i></template>',
  '/p/src/components/site-styled.html': '<template data-sn-props><p class="s">styled</p></template><style>.s { color: red }</style>',
  // a cycle of tags: neither is kept for the build (its kind depends on where the walk entered it)
  '/p/src/components/site-ping.html': '<template data-sn-props="{ n: number }"><template data-sn-if="n > 0"><site-pong data-sn-with="{ n: n - 1 }"></site-pong></template><template data-sn-else><i>ping</i></template></template>',
  '/p/src/components/site-pong.html': '<template data-sn-props="{ n: number }"><template data-sn-if="n > 0"><site-ping data-sn-with="{ n: n - 1 }"></site-ping></template><template data-sn-else><b>pong</b></template></template>',
};
const reads: string[] = [];
const options = (extra: Partial<CompileOptions> = {}): CompileOptions => ({
  file: '/p/index.html', root: '/p', dev: false, prerender: true,
  helpers: { module: '/h.js', names: [], namespaces: {} },
  componentNames: Object.keys(FILES).map((f) => f.slice(f.lastIndexOf('/') + 1, -5)),
  readFile: (p: string) => { reads.push(p); if (p in FILES) return FILES[p]!; throw new Error('missing'); },
  ...extra,
});
const BODIES = [
  '<site-card data-sn-with="{ title: \'A\' }">text</site-card><site-ping data-sn-with="{ n: 3 }"></site-ping>',
  '<site-styled></site-styled><site-broken></site-broken><site-card data-sn-with="{ title: \'B\' }"></site-card>',
  '<sn-component use="{ a: \'site-card\', b: \'site-title\' }[\'b\']" data-sn-with="{ title: \'C\' }"></sn-component><site-pong data-sn-with="{ n: 2 }"></site-pong>',
];
const same = (a: ReturnType<typeof compile>, b: ReturnType<typeof compile>) => {
  expect(b.html).toBe(a.html);
  expect(b.module).toBe(a.module);
  expect(b.diagnostics).toEqual(a.diagnostics);
};

describe('componentCache', () => {
  test('compiles that share it give what each gives alone, in any order', () => {
    const alone = BODIES.map((b) => compile(page(b), options()));
    for (const order of [[0, 1, 2], [2, 1, 0], [1, 0, 2, 1, 2, 0]]) {
      const componentCache = new Map<string, unknown>();
      for (const i of order) same(alone[i]!, compile(page(BODIES[i]!), options({ componentCache })));
    }
  });

  test('a later compile reads none of the component files again, but those on a cycle', () => {
    const componentCache = new Map<string, unknown>();
    compile(page(BODIES[0]!), options({ componentCache }));
    reads.length = 0;
    compile(page(BODIES[0]!), options({ componentCache }));
    const read = new Set(reads.filter((f) => f.includes('/components/')).map((f) => f.slice(f.lastIndexOf('/') + 1)));
    expect([...read].filter((f) => !f.startsWith('site-ping') && !f.startsWith('site-pong'))).toEqual([]);
    expect(read.has('site-ping.html')).toBe(true);
  });

  test('what a compile marks on its copy (an invalid file, a component\'s scoped CSS) is reported by every compile', () => {
    const componentCache = new Map<string, unknown>();
    const a = compile(page(BODIES[1]!), options({ componentCache }));
    const b = compile(page(BODIES[1]!), options({ componentCache }));
    expect(a.diagnostics.some((d) => d.code === 'SN312')).toBe(true);
    expect(compile(page(BODIES[0]!), options({ componentCache })).html).toMatch(/<(i>ping|b>pong)/);
    same(a, b);
    expect(b.html).toContain('styled');
  });
});
