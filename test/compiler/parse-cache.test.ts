// Expressions parsed once per source text (src/compiler/parse.ts): the same text and options give the same tree,
// frozen at every depth so that no caller can change it for the next; a syntax error is thrown again, the same.
import { describe, expect, test } from 'vitest';
import { parseExpression, parseProgram } from '../../src/compiler/parse.js';

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
