// Pages without JavaScript (docs/static-pages.md): why a page needs the runtime, the page with nothing to run
// (no script, its stylesheets linked), and SN322 for a page that must ship none.
import { describe, expect, test } from 'vitest';
import { compile } from '../../src/compiler/index.js';
import { staticPattern } from '../../src/project.js';

const files: Record<string, string> = {
  '/p/src/components/site-footer.html': '<template data-sn-component="">\n<footer data-sn-state="{ n: 0 }">\n  <button data-sn-on-click="n++">+</button><b data-sn-text="n"></b>\n</footer>\n</template>\n',
  '/p/src/components/site-title.html': '<template data-sn-component="{ t: string }"><h1 class="t" data-sn-text="t"></h1></template>\n<style>.t { color: red; }</style>\n',
};
const build = (body: string, more: Record<string, unknown> = {}) => compile(`<!doctype html><html><head><title>x</title></head><body>${body}</body></html>`, {
  file: '/p/about.html', root: '/p', dev: false, prerender: true, moduleSrc: '/@sinter/about.html.js',
  helpers: { module: '/h.js', names: ['fmt'], namespaces: {} }, componentCss: (n: string) => `/@sinter/component-css/${n}.css`,
  early: { module: '/src/sinter.early.ts', src: null }, observe: true,
  readFile: (p: string) => { if (p in files) return files[p]!; throw new Error('missing'); }, ...more,
});

describe('a page with nothing to run', () => {
  test('no script, no early script (not even for the app\'s early module), the components\' styles linked', () => {
    const out = build('<site-title data-sn-prop="{ t: \'About\' }"></site-title><p>Hi.</p>');
    expect(out.static).toBe(true);
    expect(out.runtime).toEqual([]);
    expect(out.early).toBeNull();
    expect(out.html).not.toContain('<script');
    expect(out.html).toContain('<link rel="stylesheet" href="/@sinter/component-css/site-title.css"></head>');
    expect(out.html).toContain('<h1 class="t" data-sn-c="site-title">About</h1>');
  });

  test('without prerender nothing is decided: the page keeps its script', () => {
    const out = build('<p>Hi.</p>', { prerender: false });
    expect(out.static).toBeUndefined();
    expect(out.html).toContain('<script type="module" src="/@sinter/about.html.js">');
  });
});

describe('why a page needs the runtime', () => {
  test('each thing, where it was written: the page first, then the components, in document order', () => {
    const out = build('<site-footer></site-footer>\n<sn-resource name="countries" src="/api/countries" type="any"></sn-resource>\n<p data-sn-text="fmt()"></p>');
    expect(out.static).toBeUndefined();
    expect(out.runtime.map((r) => `${r.what} ${r.file.replace('/p/', '')}:${r.line}`)).toEqual([
      'resource `countries` about.html:2',
      '`data-sn-text` about.html:3',
      '`data-sn-state` src/components/site-footer.html:2',
      '`data-sn-on-click` src/components/site-footer.html:3',
      '`data-sn-text` src/components/site-footer.html:3',
    ]);
  });

  test('SN322 for a page that must ship none: once for each, where it was written', () => {
    const out = build('<site-footer></site-footer><p>Hi.</p>', { static: true });
    const d = out.diagnostics.filter((x) => x.code === 'SN322');
    expect(d.map((x) => `${x.file.replace('/p/', '')}:${x.line} ${x.message}`)).toEqual([
      'src/components/site-footer.html:2 about.html must ship no JavaScript (`sinter({ static })`), but `data-sn-state` runs in the browser',
      'src/components/site-footer.html:3 about.html must ship no JavaScript (`sinter({ static })`), but `data-sn-on-click` runs in the browser',
      'src/components/site-footer.html:3 about.html must ship no JavaScript (`sinter({ static })`), but `data-sn-text` runs in the browser',
    ]);
    expect(build('<site-title data-sn-prop="{ t: \'About\' }"></site-title>', { static: true }).diagnostics).toEqual([]);
  });
});

test('static patterns: `*` within a folder, `**` across folders', () => {
  const m = (p: string, f: string) => staticPattern(p).test(f);
  expect(m('about.html', 'about.html')).toBe(true);
  expect(m('*.html', 'docs/a.html')).toBe(false);
  expect(m('docs/**', 'docs/a.html')).toBe(true);
  expect(m('docs/**', 'docs/x/y.html')).toBe(true);
  expect(m('docs/**/*.html', 'docs/a.html')).toBe(true);
  expect(m('docs/**/*.html', 'docs/x/a.html')).toBe(true);
  expect(m('a?.html', 'ab.html')).toBe(true);
  expect(m('a.html', 'aXhtml')).toBe(false);
});
