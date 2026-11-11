// Layouts in tests: `render(html, { layouts })` takes the app's layouts by name, as `components` does.
import { describe, expect, test } from 'vitest';
import { render } from '../../src/testing/index.js';

const LAYOUT = `<!doctype html><html lang="en" data-sn-layout="{ title: string }">
<head><title data-sn-text="title"></title><slot name="head"></slot></head>
<body><header>Site</header><main><slot></slot></main></body></html>`;

describe('layouts in render()', () => {
  test('a page that is only the layout tag is merged with it', async () => {
    const { root } = await render(`<app-layout data-sn-state="{ n: 2 }" data-sn-prop="{ title: 'Tasks' }"><p data-sn-text="n + 1"></p></app-layout>`, { layouts: { 'app-layout': LAYOUT } });
    expect(root.querySelector('header')?.textContent).toBe('Site');
    expect(root.querySelector('main p')?.textContent).toBe('3');
  });

  test('a build error in the page is thrown', async () => {
    await expect(render(`<app-layout data-sn-prop="{ title: 'x' }"></app-layout><p>extra</p>`, { layouts: { 'app-layout': LAYOUT } })).rejects.toThrow(/SN319/);
  });
});
