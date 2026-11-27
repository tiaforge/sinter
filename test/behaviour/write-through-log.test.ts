// Dev builds log what write-through applied as a trace, which strict mode does not fail on.
import { expect, test, vi } from 'vitest';
import dev, { warningSink } from '../../src/dev.js';
import type { App } from '../../src/runtime/app.js';

test('what write-through applied is logged at debug level on each application, and strict mode never sees it', () => {
  const debug = vi.spyOn(console, 'debug').mockImplementation(() => {});
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const before = warningSink().list.length;
  const app = { beforeFlush: [], afterFlush: [], states: [], page: {}, req: {}, ir: { actions: [] }, env: { href: () => 'http://localhost/' } } as unknown as App;
  dev.install(app);
  app.warn(21, 'POST /api/articles/x/favorite', 'articles: merge');
  app.warn(21, 'POST /api/articles/x/favorite', 'articles: merge');
  expect(debug.mock.calls.map((c) => c[0])).toEqual(Array(2).fill('sinter: write-through after `POST /api/articles/x/favorite`: articles: merge'));
  expect(warn).not.toHaveBeenCalled();
  expect(warningSink().list.length).toBe(before);
  debug.mockRestore(); warn.mockRestore();
});
