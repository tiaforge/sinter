// Which functions read a state object or one of its fields (`stateReaders`, for `fixedDeps`): one scan
// of the page's functions, which must answer as the regular expressions it replaced, per field.
import { describe, expect, test } from 'vitest';
import { compile } from '../../src/compiler/index.js';
import { stateReaders } from '../../src/compiler/compile.js';

// the oracle: fixedDeps before the index, one regular expression per object or field, over every function
const readsWhole = (c: string, sid: number) => new RegExp(`\\$s${sid}(?![\\w$.])`).test(c);
const readsField = (c: string, sid: number, k: string) => new RegExp(`\\$s${sid}\\.${k.replace(/\$/g, '\\$')}(?![\\w$])`).test(c);

const sources = (m: Map<string, Set<string>>, key: string) => [...(m.get(key) ?? [])].sort();

describe('stateReaders', () => {
  test('the object read whole, and each field, by the functions that read them', () => {
    const m = stateReaders(['($) => ($.$s1.a)', '($) => ($.$s1[k])', '($) => ($.$s1.a.b + $.$s2.c)']);
    expect(sources(m, '$s1.a')).toEqual(['($) => ($.$s1.a)', '($) => ($.$s1.a.b + $.$s2.c)']);
    expect(sources(m, '$s1')).toEqual(['($) => ($.$s1[k])']);
    expect(sources(m, '$s2.c')).toEqual(['($) => ($.$s1.a.b + $.$s2.c)']);
    // `$s1.a.b` reads field `a`: no field `b`, no `a.b`
    expect(m.has('$s1.b')).toBe(false);
    expect(m.has('$s1.a.b')).toBe(false);
  });

  test('a longer scope number or field name is another one', () => {
    const m = stateReaders(['($) => ($.$s12.ab)', '($) => ($.$s12)']);
    expect(m.has('$s1')).toBe(false);
    expect(m.has('$s1.ab')).toBe(false);
    expect(m.has('$s12.a')).toBe(false);
    expect(sources(m, '$s12.ab')).toEqual(['($) => ($.$s12.ab)']);
    expect(sources(m, '$s12')).toEqual(['($) => ($.$s12)']);
  });

  test('`$`, a word character or a `.` without a name after it is no read', () => {
    const m = stateReaders(['($) => ($s1$ + $s1x + $s1. + $s1.$a)']);
    expect(m.has('$s1')).toBe(false);
    expect([...m.keys()]).toEqual(['$s1.$a']);
  });

  test('each source once; removed functions (`0`) are no readers', () => {
    const m = stateReaders(['($) => ($.$s0.a)', '($) => ($.$s0.a)', '0']);
    expect(sources(m, '$s0.a')).toEqual(['($) => ($.$s0.a)']);
    expect(stateReaders(['0']).size).toBe(0);
  });

  test('random functions: the index answers as one regular expression per object and field', () => {
    let seed = 7;
    const rnd = (n: number) => { seed = (seed * 1103515245 + 12345) % 2 ** 31; return seed % n; };
    const pick = <T,>(xs: T[]) => xs[rnd(xs.length)]!;
    const bits = ['$s1', '$s12', '$s2', '$s1.', '$s12.', '$s2.', '.', 'a', 'ab', '$a', '$', 'x', '[k]', ' + ', '(', ')', '1'];
    const keys = ['a', 'ab', '$a', 'b', 'x'];
    let hits = 0;
    for (let n = 0; n < 5000; n++) {
      const fns = Array.from({ length: 1 + rnd(4) }, () => Array.from({ length: 1 + rnd(10) }, () => pick(bits)).join(''));
      const m = stateReaders(fns);
      for (const sid of [1, 2, 12]) {
        const want = [...new Set(fns.filter((c) => readsWhole(c, sid)))].sort();
        expect({ fns, sid, got: sources(m, `$s${sid}`) }).toEqual({ fns, sid, got: want });
        for (const k of keys) {
          const wantK = [...new Set(fns.filter((c) => readsField(c, sid, k)))].sort();
          expect({ fns, sid, k, got: sources(m, `$s${sid}.${k}`) }).toEqual({ fns, sid, k, got: wantK });
          if (wantK.length) hits++;
        }
      }
    }
    // the cases cover reads, not only misses
    expect(hits).toBeGreaterThan(200);
  });
});

describe('state fields nothing reads, on a page with many scopes', () => {
  const build = (body: string) => compile(`<!doctype html><html><head></head><body>${body}</body></html>`, {
    file: '/p/index.html', root: '/p', dev: false, prerender: true,
    helpers: { module: null, names: [], namespaces: {} }, readFile: () => { throw new Error('missing'); },
  });

  test('a field read only in the markup is out of the state; a written field whose name starts with it, and `$s12`\'s fields, do not keep it', () => {
    // `a` is read once, into the markup; `ab` is written and read; 13 scopes, so `$s1` and `$s12` both exist
    const sec = (i: number) => `<div data-sn-state="{ a: 'x', ab: 'y', n${i}: 0 }"><button data-sn-on-click="ab = 'z'; n${i}++"></button>`
      + `<template data-sn-if="n${i}"><b data-sn-class="{ on: a == 'x' }">k</b><i data-sn-text="ab"></i></template></div>`;
    const out = build(Array.from({ length: 13 }, (_, i) => sec(i)).join(''));
    expect(out.diagnostics).toEqual([]);
    for (let i = 0; i < 13; i++) expect(out.module).toContain(`($) => ({ "ab": ('y'), "n${i}": (0) })`);
    expect(out.module).not.toContain('"a":');
  });

  test('a field a function of an inner scope reads is kept', () => {
    const out = build(`<div data-sn-state="{ a: 'x', n: 0 }"><button data-sn-on-click="n++"></button><template data-sn-if="n"><b data-sn-class="{ on: a == 'x' }">k</b></template>`
      + `<p data-sn-state="{ m: 0 }"><button data-sn-on-click="m++"></button><i data-sn-text="m + a"></i></p></div>`);
    expect(out.diagnostics).toEqual([]);
    // the state stays as written, `a` with it
    expect(out.module).toContain("($) => ({ a: 'x', n: 0 })");
  });
});
