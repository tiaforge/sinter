// Expressions parsed once per source text (src/compiler/parse.ts): the same text and options give the same tree,
// frozen at every depth so that no caller can change it for the next; a syntax error is thrown again, the same.
import { describe, expect, test } from 'vitest';
import { freeRefs, parseExpression, parseProgram } from '../../src/compiler/parse.js';

describe('parse cache', () => {
  test('the same text gives the same tree, frozen at every depth', () => {
    const a = parseExpression('item.tags.includes(t) ? 1 : 2');
    expect(parseExpression('item.tags.includes(t) ? 1 : 2')).toBe(a);
    expect(Object.isFrozen(a)).toBe(true);
    const test_ = (a as unknown as { test: { callee: { object: object } } }).test;
    expect(Object.isFrozen(test_.callee.object)).toBe(true);
    expect(() => { (a as unknown as { type: string }).type = 'Literal'; }).toThrow(TypeError);
  });

  test('options are part of the key', () => {
    const plain = parseExpression('(a ? b : c)');
    const parens = parseExpression('(a ? b : c)', { ecmaVersion: 'latest', preserveParens: true });
    expect(parens).not.toBe(plain);
    expect(plain.type).toBe('ConditionalExpression');
    expect(parens.type).toBe('ParenthesizedExpression');
    expect(parseProgram('a; b')).not.toBe(parseExpression('a; b'));
  });

  test('a syntax error is thrown each time, with its position', () => {
    const at = () => { try { parseExpression('a +'); } catch (e) { return (e as { pos: number }).pos; } return null; };
    expect(at()).toBe(3);
    expect(at()).toBe(3);
  });

  test('a prefix parse ends where the expression does, as acorn would', () => {
    expect(parseExpression('a + b; c').end).toBe(5);
  });
});

describe('freeRefs', () => {
  const free = (src: string, program = false) => {
    const out: string[] = [];
    freeRefs(program ? parseProgram(src) : parseExpression(src), (id, shorthand) => out.push(shorthand ? `{${id.name}}` : id.name));
    return out;
  };
  test('not members\' or keys\' names; a shorthand property is its reference', () => {
    expect(free('{ a: b.c, [d]: e, f, g: h?.[i] }')).toEqual(['b', 'd', 'e', '{f}', 'h', 'i']);
  });
  test('not the names functions bind: parameters, destructured, their defaults read in their scope', () => {
    expect(free('xs.map((x, { y, z: [w] }, ...r) => x + y + w + r + v)')).toEqual(['xs', 'v']);
    expect(free('(a = b, c = a) => c')).toEqual(['b']);
    expect(free('function f({ [k]: g }) { return f(g) }')).toEqual(['k']);
    expect(free('class C extends B { m(p) { return C + p + q } }')).toEqual(['B', 'q']);
  });
  test('not the names blocks, catches, loops and function bodies declare, where they are in scope', () => {
    expect(free('{ let a = 1; a; } a; try { b } catch ({ e }) { e; c } for (const i of is) i; label: for (var j in o) break label; j', true))
      .toEqual(['a', 'b', 'c', 'is', 'o']);
    expect(free('() => { if (x) { var v = 1; function g() {} } return v + g + w }')).toEqual(['x', 'w']);
  });
  test('a name assigned is a reference', () => {
    expect(free('(a = 1, b++, [c, { d }] = e)')).toEqual(['a', 'b', 'c', '{d}', 'e']);
  });
});
