// Helpers over constants run at build time (docs/spec.md, Helpers at build time): a helper call in a binding
// or a state initializer whose arguments are build-time constants runs in the compiler when the static check
// lets it, and its plain-data result joins the constants; `file:` values are constants too.
import { describe, expect, test } from 'vitest';
import { compile, type CompileOptions } from '../../src/compiler/index.js';
import { firstPaint, render } from '../../src/testing/index.js';
import type { FoldVerdict } from '../../src/fold-check.js';

const yes: FoldVerdict = { fold: true };
const no = (reason: string): FoldVerdict => ({ fold: false, reason, file: '/p/src/lib/x.ts', line: 3, col: 7, chain: ['stamp'] });

/** compiles a page under /p as a build does, with the helpers given (values and verdicts) */
function build(html: string, helpers: Record<string, [unknown, FoldVerdict]>, o: Partial<CompileOptions> = {}, files: Record<string, string> = {}) {
  const names = Object.keys(helpers).filter((k) => !k.includes('.'));
  const ns: Record<string, { module: string; members: string[] }> = {};
  const values: Record<string, unknown> = {}, fold = new Map<string, FoldVerdict>();
  for (const [k, [v, verdict]] of Object.entries(helpers)) {
    const [a, b] = k.split('.') as [string, string | undefined];
    if (b) { (ns[a] ??= { module: `/src/${a}.ts`, members: [] }).members.push(b); ((values[a] ??= {}) as Record<string, unknown>)[b] = v; fold.set(`${a}$${b}`, verdict); }
    else { values[a] = v; fold.set(a, verdict); }
  }
  return compile(html, {
    file: '/p/index.html', root: '/p', dev: true, prerender: true,
    helpers: { module: '/src/sinter.helpers.ts', names, namespaces: ns },
    readFile: (f) => { const t = files[f.replace(/^\/p\//, '')]; if (t === undefined) throw new Error(`no such file: ${f}`); return t; },
    helperValues: values, helperFold: fold, ...o,
  });
}
const errors = (out: ReturnType<typeof build>) => out.diagnostics.filter((d) => d.severity === 'error').map((d) => `${d.code} ${d.message}`);
const warnings = (out: ReturnType<typeof build>) => out.diagnostics.filter((d) => d.code === 'SN534').map((d) => d.message);
const upper = (s: string) => s.toUpperCase();

describe('a helper call over constants runs at build time', () => {
  test('in a binding: its result is written into the HTML, and the page module does not call it', () => {
    const out = build(`<main data-sn-state="{ name: 'ada' }"><p data-sn-text="upper(name)"></p></main>`, { upper: [upper, yes] });
    expect(errors(out)).toEqual([]);
    expect(out.html).toContain('<p>ADA</p>');
    expect(out.module).not.toContain('upper');
  });

  test('in a state initializer, a namespace member, a cached let, and the list of a loop that unrolls', () => {
    const split = (s: string) => s.split(' ').map((w) => ({ w }));
    const out = build(`<main data-sn-state="{ title: fmt.title('hello world') }" data-sn-let="{ words: split(title) }">
      <h1 data-sn-text="title"></h1><ul><template data-sn-for="x in words"><li data-sn-text="x.w"></li></template></ul></main>`,
    { 'fmt.title': [(s: string) => s.replace(/\b\w/g, (c) => c.toUpperCase()), yes], split: [split, yes] });
    expect(errors(out)).toEqual([]);
    expect(out.html).toContain('<h1>Hello World</h1>');
    expect(out.html).toMatch(/<li>Hello<\/li><li>World<\/li>/);
    expect(out.module).not.toMatch(/fmt\$title|split/);
  });

  test('a page calls a helper once per arguments (and once more for the check), whatever its passes evaluate; the next page again', () => {
    let calls = 0;
    const words = (s: string) => { calls++; return s.split(' ').map((w) => ({ w })); };
    // a let read by several bindings, a loop that unrolls, and a decided condition: the page is compiled twice
    const html = `<main data-sn-state="{ s: 'a b c' }" data-sn-let="{ ws: words(s) }"><b data-sn-text="ws.length"></b>
      <ul><template data-sn-for="x in ws"><li data-sn-text="x.w"></li></template></ul><template data-sn-if="ws.length > 2"><i>long</i></template><p data-sn-text="words(s)[0].w"></p></main>`;
    const out = build(html, { words: [words, yes] }, { dev: false });
    expect(errors(out)).toEqual([]);
    expect(out.html).toMatch(/<li>a<\/li><li>b<\/li><li>c<\/li>/);
    expect(calls).toBe(2);
    // another page (another file) starts again
    build(html, { words: [words, yes] }, { dev: false, file: '/p/other.html' });
    expect(calls).toBe(4);
  });

  test('a build (`foldLog`): each distinct call runs once in the page and is logged for the cross-check at the end of the build', () => {
    let calls = 0;
    const words = (s: string) => { calls++; return s.split(' '); };
    const log: Array<[string, unknown[], string]> = [];
    const out = build(`<main data-sn-state="{ s: 'a b' }"><b data-sn-text="words(s).length"></b><i data-sn-text="words(s)[0]"></i></main>`,
      { words: [words, yes] }, { dev: false, foldLog: (k, a, j) => log.push([k, a, j]) });
    expect(out.html).toContain('<b>2</b><i>a</i>');
    expect(calls).toBe(1);
    expect(log).toEqual([['words', ['a b'], '["a","b"]']]);
  });

  test('not in a handler: a click runs it in the browser', async () => {
    let calls = 0;
    const out = build(`<main data-sn-state="{ n: '' }"><button data-sn-on-click="n = upper('x')"></button><p data-sn-text="n"></p></main>`, { upper: [(s: string) => { calls++; return s.toUpperCase(); }, yes] });
    expect(errors(out)).toEqual([]);
    expect(calls).toBe(0);
    expect(out.module).toContain('upper');
  });

  test('a helper the static check does not let fold stays in the browser, and SN322 says why on a static page', () => {
    const out = build(`<main data-sn-state="{ s: 'x' }"><p data-sn-text="stamp(s)"></p></main>`, { stamp: [(s: string) => s + Date.now(), no('`Date`')] }, { static: true });
    expect(out.html).toContain('<p data-sn="');
    expect(errors(out)).toEqual(expect.arrayContaining([expect.stringContaining('but `data-sn-text` (`stamp()` cannot run at build time: it reaches `Date` (src/lib/x.ts:3:7), which is not one of the globals a build-time call may use) runs in the browser')]));
  });

  test('a call that throws, returns what is not plain data, or another result the second time: in the browser, SN534 at the call (dev), once', () => {
    let n = 0;
    const out = build(`<main data-sn-state="{ s: 'x' }"><p data-sn-text="boom(s)"></p><p data-sn-text="when(s)"></p><p data-sn-text="drift(s)"></p><p data-sn-text="boom(s) + 1"></p></main>`, {
      boom: [() => { throw new Error('nope'); }, yes], when: [() => new Date(0), yes], drift: [() => String(n++), yes],
    });
    expect(warnings(out)).toEqual([
      '`boom()` threw at build time (nope), so this call stays in the browser',
      '`when()` returned something that is not plain data (JSON values), so this call stays in the browser',
      '`drift()` returned another result when called again with the same arguments: a helper must be pure, so this call stays in the browser',
      '`boom()` threw at build time (nope), so this call stays in the browser',
    ]);
    expect(out.diagnostics.find((d) => d.code === 'SN534')!.severity).toBe('warning');
    expect(out.module).toMatch(/boom/);
    // a production build does not warn
    expect(warnings(build(`<main data-sn-state="{ s: 'x' }"><p data-sn-text="boom(s)"></p></main>`, { boom: [() => { throw new Error('nope'); }, yes] }, { dev: false }))).toEqual([]);
    // and runs each call twice too: a helper that changes between calls in a way the static check cannot see stays in the browser
    let m = 0;
    const prod = build(`<main data-sn-state="{ s: 'x' }"><p data-sn-text="drift(s)"></p><i data-sn-text="upper(s)"></i></main>`, { drift: [() => String(m++), yes], upper: [upper, yes] }, { dev: false });
    expect(prod.html).toContain('<i>X</i>');
    expect(prod.html).not.toMatch(/<p>\d<\/p>/);
    expect(prod.module).toMatch(/drift/);
  });

  test('render() and firstPaint() fold too: a helper whose own source reads only its arguments', async () => {
    const r = await firstPaint(`<main data-sn-state="{ s: 'ab' }"><p data-sn-text="twice(s)"></p><i data-sn-text="later(s)"></i></main>`, { helpers: { twice: (s: string) => s + s, later: (s: string) => s + Date.now() } });
    expect(r.html).toContain('<p>abab</p>');
    expect(r.html).not.toMatch(/<i>ab\d+<\/i>/);
    const rendered = await render(`<main data-sn-state="{ s: 'ab' }"><p data-sn-text="twice(s)"></p></main>`, { helpers: { twice: (s: string) => s + s } });
    expect(rendered.root.querySelector('p')!.textContent).toBe('abab');
  });
});

describe('a folded value the browser still reads is written once, as embedded data', () => {
  const page = `<!doctype html><html><head></head><body><main data-sn-state="{ open: false, title: titled('hello world') }">
    <button data-sn-on-click="open = !open"></button><h1 data-sn-text="open ? title : '…'"></h1></main></body></html>`;
  const titled = (s: string) => s.replace(/\b\w/g, (c) => c.toUpperCase());

  test('the state field reads it from the head; the helper is in neither the page module nor the early file', () => {
    const out = build(page, { titled: [titled, yes] }, { early: { module: null } });
    expect(errors(out)).toEqual([]);
    expect(out.html).toMatch(/<script type="application\/json" data-sn="(\d+)">"Hello World"<\/script>/);
    const id = /data-sn="(\d+)">"Hello World"/.exec(out.html)![1];
    expect(out.module).toContain(`$.$d(${id})`);
    expect(out.module).not.toContain('titled');
    expect(out.early ?? '').not.toContain('titled');
  });

  test('at run time and in the first paint: the value, a copy per state', async () => {
    const r = await render(page, { helpers: { titled } });
    expect(r.root.querySelector('h1')!.textContent).toBe('…');
    r.root.querySelector('button')!.click();
    await r.flush();
    expect(r.root.querySelector('h1')!.textContent).toBe('Hello World');
    const early = await firstPaint(page.replace('open: false', 'open: true').replace('data-sn-on-click="open = !open"', 'data-sn-on-click="open = false"'), { helpers: { titled } });
    expect(early.root.querySelector('h1')!.textContent).toBe('Hello World');
  });

  test('a helper of a module that reaches a lazy package does not fold, with that reason', () => {
    const waits = build(`<main data-sn-state="{ s: 'x' }" data-sn-let="{ v: slow(s) }"><p data-sn-text="v"></p></main>`, { slow: [upper, yes] }, { static: true, lazyModule: (m) => (m === '/src/sinter.helpers.ts' ? ['fakelib'] : []) });
    expect(waits.html).not.toContain('<p>X</p>');
    expect(errors(waits)).toEqual(expect.arrayContaining([expect.stringContaining('`slow()` cannot run at build time: its module reaches a lazy package')]));
  });
});

describe('file: values are constants', () => {
  const files = { 'intro.txt': 'hello there', 'team.json': JSON.stringify({ people: [{ id: 1, name: 'Ada' }, { id: 2, name: 'Grace' }] }) };

  test('bindings and loops over them fold; when nothing in the browser reads one, it leaves the page, which can ship no JavaScript', () => {
    const out = build(`<!doctype html><html><head></head><body>
      <sn-resource name="intro" src="file:./intro.txt"></sn-resource>
      <sn-resource name="team" src="file:./team.json" items="people" key="id"></sn-resource>
      <p data-sn-text="upper(intro)"></p><b data-sn-text="$meta.intro.loading ? '…' : 'ready'"></b>
      <ul><template data-sn-for="p in team"><li data-sn-text="p.name"></li></template></ul></body></html>`, { upper: [upper, yes] }, { static: true }, files);
    expect(errors(out)).toEqual([]);
    expect(out.static).toBe(true);
    expect(out.html).toContain('<p>HELLO THERE</p>');
    expect(out.html).toContain('<b>ready</b>');
    expect(out.html).toMatch(/<li>Ada<\/li><li>Grace<\/li>/);
    expect(out.html).not.toContain('application/json');
  });

  test('what still runs in the browser reads it from the embedded data', () => {
    const out = build(`<!doctype html><html><head></head><body><sn-resource name="intro" src="file:./intro.txt"></sn-resource>
      <main data-sn-state="{ open: false }"><button data-sn-on-click="open = !open"></button><p data-sn-text="open ? intro : ''"></p><i data-sn-text="intro"></i></main></body></html>`, {}, {}, files);
    expect(errors(out)).toEqual([]);
    expect(out.html).toContain('<i>hello there</i>');
    expect(out.html).toContain('"hello there"</script>');
    expect(out.module).toContain('$.$r.intro');
  });
});
