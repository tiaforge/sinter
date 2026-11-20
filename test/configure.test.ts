import { expect, test } from 'vitest';
import { configure } from '../src/runtime/config.js';

test('configure() takes known options only: a typo fails instead of doing nothing', () => {
  expect(() => configure({ sesionProbe: '/api/me' } as never)).toThrow('configure({ sesionProbe }) is not an option');
});
