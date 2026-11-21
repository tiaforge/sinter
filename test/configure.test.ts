import { expect, test } from 'vitest';
import { configure } from '../src/runtime/config.js';

test('configure() takes known options only: a typo fails instead of doing nothing', () => {
  expect(() => configure({ sesionProbe: '/api/me' } as never)).toThrow('configure({ sesionProbe }) is not an option');
});

test('env is not an option of configure(): it is the tests\' seam', () => {
  expect(() => configure({ env: {} } as never)).toThrow('configure({ env }) is not an option');
});

test('apis is not an option of configure(): the page module sets the build\'s, sinter({ apis }), after the config module ran', () => {
  expect(() => configure({ apis: [] } as never)).toThrow('configure({ apis }) is not an option: the APIs are `sinter({ apis })`');
});
