import { describe, expect, test } from 'vitest';
import { compile } from '../../src/compiler/index.js';

// A literal `id` the page would have more than once: SN209 when it is written in two places (or in a component used
// twice), SN532 when one place renders more than once (a row). Uses that are never on the page together (an if's
// branches, a choice's candidates, a list's empty state) are not counted against each other.

function build(body: string, components: Record<string, string> = {}) {
  const files: Record<string, string> = {};
  for (const [k, v] of Object.entries(components)) files[`/p/src/components/${k}.html`] = v;
  return compile(`<!doctype html><html><head></head><body><div data-sn-state="{ list: [1, 2], on: true, k: 'a' }">${body}</div></body></html>`, {
    file: '/p/index.html', root: '/p', dev: false, componentNames: Object.keys(components),
    helpers: { module: null, names: [], namespaces: {} }, readFile: (p) => { if (p in files) return files[p]!; throw new Error(p); },
  }).diagnostics.map((d) => `${d.code} ${d.message.replace(/ \(included from .*\)$/, '')}`);
}

const field = '<template data-sn-props=""><div><label for="email">Email</label><input id="email"></div></template>';
const plain = '<template data-sn-props=""><p></p></template>';
const slot = '<template data-sn-props=""><div><slot></slot></div></template>';

describe('written in two places', () => {
  test('in the page', () => {
    expect(build('<p id="a"></p><p id="a"></p><p id="a"></p>')).toEqual(['SN209 `id="a"` is also the id of `<p>` at index.html:1: the page would have that id 3 times']);
    expect(build('<p id="a"></p><p id="b"></p>')).toEqual([]);
  });

  test('two components, or a component and the page', () => {
    const other = { 'x-f': field, 'x-g': '<template data-sn-props=""><p id="email"></p></template>' };
    expect(build('<x-f></x-f><x-g></x-g>', other)).toEqual(['SN209 `id="email"` is also the id of `<input>` at x-f.html:1: the page would have that id 2 times']);
    expect(build('<x-f></x-f><p id="email"></p>', { 'x-f': field })).toEqual(['SN209 `id="email"` is also the id of `<input>` at x-f.html:1: the page would have that id 2 times']);
  });

  test('two fills', () => {
    expect(build('<x-s><b id="a"></b></x-s><x-s><b id="a"></b></x-s>', { 'x-s': slot })).toEqual(['SN209 `id="a"` is also the id of `<b>` at index.html:1: the page would have that id 2 times']);
    expect(build('<x-s><b id="a"></b></x-s><x-s><b id="b"></b></x-s>', { 'x-s': slot })).toEqual([]);
  });

  test('on two component tags, reported where the tags are, also through a component that passes it on', () => {
    expect(build('<x-p id="t"></x-p><x-p id="t"></x-p>', { 'x-p': plain })).toEqual(['SN209 `id="t"` is also the id of `<x-p>` at index.html:1: the page would have that id 2 times']);
    expect(build('<x-p id="t"></x-p><x-p id="u"></x-p>', { 'x-p': plain })).toEqual([]);
    const outer = { 'x-p': plain, 'x-o': '<template data-sn-props=""><x-p></x-p></template>' };
    expect(build('<x-o id="a"></x-o><x-o id="a"></x-o>', outer)).toEqual(['SN209 `id="a"` is also the id of `<x-o>` at index.html:1: the page would have that id 2 times']);
    expect(build('<x-o id="a"></x-o><x-o id="b"></x-o>', outer)).toEqual([]);
  });

  test('not into a template that is not sinter\'s', () => {
    expect(build('<p id="a"></p><div><template shadowrootmode="open"><p id="a"></p></template></div>')).toEqual([]);
  });
});

describe('a component used more than once', () => {
  test('its markup\'s id, also an id on an inner component\'s tag in it', () => {
    expect(build('<x-f></x-f><x-f></x-f>', { 'x-f': field })).toEqual([expect.stringMatching(/^SN209 `<x-f>` is used 2 times on this page, and its markup has `id="email"`: the page would have that id 2 times/)]);
    expect(build('<x-o></x-o><x-o></x-o>', { 'x-p': plain, 'x-o': '<template data-sn-props=""><section><x-p id="in"></x-p></section></template>' }))
      .toEqual([expect.stringMatching(/^SN209 `<x-o>` is used 2 times on this page, and its markup has `id="in"`/)]);
  });

  test('in a row: SN532, once', () => {
    expect(build('<template data-sn-for="i in list"><x-f></x-f></template>', { 'x-f': field })).toEqual([expect.stringMatching(/^SN532 `id="email"` is in markup that renders more than once/)]);
    expect(build('<template data-sn-for="i in list"><p id="a"></p></template><p id="a"></p>')).toEqual([expect.stringMatching(/^SN532 `id="a"`/)]);
  });
});

describe('never on the page together', () => {
  const twice = (n: number) => [expect.stringMatching(new RegExp(`^SN209 \`<x-f>\` is used \\d times on this page, and its markup has \`id="email"\`: the page would have that id ${n} times`))];

  test('an if\'s branches', () => {
    expect(build('<template data-sn-if="on"><x-f></x-f></template><template data-sn-else><x-f></x-f></template>', { 'x-f': field })).toEqual([]);
    expect(build('<template data-sn-if="on"><x-f></x-f></template><template data-sn-else data-sn-if="k"><x-f></x-f></template><template data-sn-else><x-f></x-f></template>', { 'x-f': field })).toEqual([]);
    // same id, same control: a twin in each branch
    expect(build('<template data-sn-if="on"><button id="f">a</button></template><template data-sn-else><button id="f">b</button></template>')).toEqual([]);
  });

  test('but a use outside the chain, or two ifs, are', () => {
    expect(build('<template data-sn-if="on"><x-f></x-f></template><template data-sn-else><x-f></x-f></template><x-f></x-f>', { 'x-f': field })).toEqual(twice(2));
    expect(build('<template data-sn-if="on"><x-f></x-f></template><template data-sn-if="k"><x-f></x-f></template>', { 'x-f': field })).toEqual(twice(2));
    expect(build('<template data-sn-if="on"><p id="a"></p></template><template data-sn-else><i></i></template><p id="a"></p>')).toEqual([expect.stringMatching(/^SN209 `id="a"` is also the id of `<p>`/)]);
  });

  test('a list\'s empty state and a choice\'s candidates', () => {
    expect(build('<template data-sn-for="i in list"><p id="e"></p></template><template data-sn-else><p id="e">none</p></template>')).toEqual([expect.stringMatching(/^SN532 `id="e"`/)]);
    expect(build('<template data-sn-for="i in list"><p></p></template><template data-sn-else><p id="none">none</p></template>')).toEqual([]);
    const cands = { 'x-a': '<template data-sn-props=""><p id="c"></p></template>', 'x-b': '<template data-sn-props=""><p id="c"></p></template>' };
    expect(build('<sn-component use="{ a: \'x-a\', b: \'x-b\' }[k]"></sn-component><template data-sn-else><p id="c"></p></template>', cands)).toEqual([]);
  });
});
