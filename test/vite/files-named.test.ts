// @vitest-environment node
// SN521's scan (src/page-urls.ts `filesNamed`): which page modules name a page's old file URL, found in one pass over
// each module instead of a pattern per page and module. It must find exactly what the pattern found.
import { expect, test } from 'vitest';
import { filesNamed } from '../../src/page-urls.js';

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** the check as it was: one pattern per file, tested on each code */
const oracle = (files: string[], codes: Array<[string, string]>, prefix: string) => {
  const out = new Map<string, string[]>();
  for (const f of files) for (const [from, code] of codes) {
    if (new RegExp(`['"\`]${esc(prefix)}${esc(`/${f}`)}(?![\\w/-])`).test(code)) (out.get(f) ?? out.set(f, []).get(f)!).push(from);
  }
  return out;
};
const sorted = (m: Map<string, string[]>) => [...m].sort(([a], [b]) => (a < b ? -1 : 1));

test('the files a module names at their old URL, as the pattern per file finds them', () => {
  const files = ['item.html', 'blog/post-1.html', 'blog/post-10.html', 'a.html', 'a.html.html', 'x-y.html'];
  const codes: Array<[string, string]> = [
    ['list.html', 'go("/item.html?id=" + id); go(`/blog/post-1.html`)'],
    ['b.html', '"/blog/post-10.html" + "/blog/post-1.htmlx" + \'/a.html.html\''],
    ['c.html', '"/item.html/x" "/item.html-y" "/item.html_z" "/x-y.html.bak" `/a.html`'],
    ['d.html', 'nothing here'],
  ];
  const got = filesNamed(files, codes, '');
  expect(sorted(got)).toEqual(sorted(oracle(files, codes, '')));
  expect(got.get('item.html')).toEqual(['list.html']);
  expect(got.get('a.html.html')).toEqual(['b.html']);
  // (a dot may follow: `/a.html.html` names `a.html` too, as the pattern did)
  expect(got.get('a.html')).toEqual(['b.html', 'c.html']);
  // under a base, the base's path first
  expect(sorted(filesNamed(files, [['e.html', '"/app/item.html" "/item.html"']], '/app'))).toEqual([['item.html', ['e.html']]]);
});

test('random modules and files: the same pairs, in the same order', () => {
  let seed = 7;
  const rnd = (n: number) => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) % n);
  const alpha = 'ab/.-_"\'` x1';
  const word = (n: number) => Array.from({ length: n }, () => alpha[rnd(alpha.length)]).join('');
  for (let round = 0; round < 300; round++) {
    const files = [...new Set(Array.from({ length: 1 + rnd(6) }, () => word(1 + rnd(4)).replace(/["'`]/g, 'a')))];
    const prefix = ['', '/p', '/a.b'][rnd(3)]!;
    const codes: Array<[string, string]> = Array.from({ length: 1 + rnd(4) }, (_, i) => [`m${i}`, Array.from({ length: 1 + rnd(8) }, () => (rnd(2) ? `${'"\'`'[rnd(3)]}${prefix}/${files[rnd(files.length)]}` : '') + word(rnd(4))).join('')]);
    expect(sorted(filesNamed(files, codes, prefix)), JSON.stringify({ files, codes, prefix })).toEqual(sorted(oracle(files, codes, prefix)));
  }
});
