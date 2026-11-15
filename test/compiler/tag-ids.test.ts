import { expect, test } from 'vitest';
import { compile } from '../../src/compiler/index.js';

function build(box: string, body: string) {
  const files: Record<string, string> = { '/p/src/components/x-box.html': box };
  return compile(`<!doctype html><html><head></head><body><div data-sn-state="{ list: [1, 2] }">${body}</div></body></html>`, {
    file: '/p/index.html', root: '/p', dev: false, componentNames: ['x-box'],
    helpers: { module: null, names: [], namespaces: {} }, readFile: (p) => { if (p in files) return files[p]!; throw new Error(p); },
  }).diagnostics.map((d) => `${d.code} ${d.message}`);
}

const uses = '<x-box id="one" data-sn-prop="{ v: 1 }"></x-box><template data-sn-for="b in list"><x-box data-sn-prop="{ v: b }"></x-box></template>';

test('an id on one use\'s tag is that use\'s, not the component\'s markup', () => {
  expect(build('<template data-sn-component="{ v?: any }"><div class="box" data-sn-text="v"></div></template>', uses)).toEqual([]);
  // on a root inside the markup's own element too
  expect(build('<template data-sn-component="{ v?: any }"><section><x-inner></x-inner></section></template>'.replace('<x-inner></x-inner>', '<b data-sn-text="v"></b>'), uses)).toEqual([]);
});

test('a literal id in the component\'s own markup still counts', () => {
  expect(build('<template data-sn-component="{ v?: any }"><div id="mine" data-sn-text="v"></div></template>', uses.replace(' id="one"', '')))
    .toEqual([expect.stringMatching(/^SN209 `<x-box>` is used 2 times on this page, and its markup has `id="mine"`/)]);
  expect(build('<template data-sn-component="{ v?: any }"><div><i id="deep" data-sn-text="v"></i></div></template>', '<x-box id="one"></x-box><x-box></x-box>'))
    .toEqual([expect.stringMatching(/its markup has `id="deep"`/)]);
});
