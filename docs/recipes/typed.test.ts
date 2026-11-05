import { expect, test } from 'vitest';
import { checkPage } from '@tiaforge/sinter/check';
import page from './typed.html?raw';
import types from './typed.types.ts?raw';

// In CI: `npx sinter check` (pages and options from the Vite config).
const files = { 'src/sinter.types.ts': types };

test('every expression type-checks', () => {
  expect(checkPage(page, { files })).toEqual([]);
});

test('a typo in a field is an error at its position, with a suggestion', () => {
  const [d] = checkPage(page.replace('c.email ??', 'c.emial ??'), { files });
  expect(d).toMatchObject({ code: 'SN208', file: 'index.html', line: 12 });
  expect(d!.message).toMatch(/Property 'emial' does not exist on type 'Contact'. Did you mean 'email'\?/);
});

test('an event payload that does not fit the resource is an error', () => {
  const [d] = checkPage(page.replace('item="contact"', 'item="contact.name"'), { files });
  expect(d!.message).toMatch(/Type 'string' is not assignable to type 'Contact'/);
});
