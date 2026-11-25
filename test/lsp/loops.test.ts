import { describe, expect, test } from 'vitest';
import { forPlace, itemName, listType } from '../../src/lsp/loops.js';

describe('forPlace', () => {
  const place = (value: string, cursor = value.length) => {
    const text = `<template data-sn-for="${value}"></template>`;
    return forPlace(text, 23 + cursor);
  };
  test('which part of the value the offset is in', () => {
    expect(place('')?.part).toBe('item');
    expect(place('con')?.part).toBe('item');
    expect(place('(c, ')?.part).toBe('item');
    expect(place('c ')?.part).toBe('in');
    expect(place('(c, i) in')?.part).toBe('in');
    expect(place('c in ')?.part).toBe('list');
    expect(place('c in contacts.filter(x => x.')?.part).toBe('list');
  });
  test('an item or `in` only where nothing but space follows; elsewhere nothing', () => {
    expect(place('c in contacts', 1)).toBeNull();
    expect(place('c x')).toBeNull();
    expect(forPlace('<div data-sn-for=""></div>', 18)).toBeNull();
    expect(forPlace('<template data-sn-if=""></template>', 22)).toBeNull();
  });
});

test('itemName', () => {
  expect(['contacts', 'entries', 'boxes', 'items', 'tagSet', 'rowList', 'data', 'news', 'status', 'cases'].map(itemName))
    .toEqual(['contact', 'entry', 'box', 'item', 'tag', 'row', 'item', 'item', 'item', 'item']);
});

test('listType: from the detail TypeScript gives a name', () => {
  expect(listType('const contacts: Contact[]')).toBe(true);
  expect(listType('let entries: string[] | null')).toBe(true);
  expect(listType('let tagSet: Set<string>')).toBe(true);
  expect(listType('(property) rows: readonly Row[]')).toBe(true);
  expect(listType('let query: string')).toBe(false);
  expect(listType('const $el: HTMLTemplateElement')).toBe(false);
  expect(listType('const merge: <T>(item: T, set: Partial<NonNullable<T>>) => void')).toBe(false);
  expect(listType('(alias) function date(v: unknown): string')).toBe(false);
  expect(listType('const $meta: Record<"contacts", Meta>')).toBe(false);
  expect(listType('const contacts: Contacts')).toBeNull();
});
