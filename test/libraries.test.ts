// Component libraries (docs/libraries.md, section 9 of the component-libraries proposal): packages in
// `sinter({ components })` ship source in an app-shaped folder, which the app's sinter compiles as its
// own components. `@fixture/ui` (test/fixtures/ui) is used by test/fixtures/ui-app through a link in
// node_modules, as a workspace links it: its real path is outside the app's root.
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterAll, describe, expect, test } from 'vitest';
import { project, viteProject, type ProjectOptions } from '../src/project.js';
import { compile, formatDiagnostic, type Diagnostic } from '../src/compiler/index.js';
import { check, findTsc } from '../src/check/index.js';
import { satisfies, sinterVersion } from '../src/libraries.js';
import { lazyHelpers } from '../src/lazy-build.js';

const UI = resolve(__dirname, 'fixtures/ui');
const tmp = mkdtempSync(join(tmpdir(), 'sinter-libraries-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

let n = 0;
/** a copy of the app fixture, with `@fixture/ui` linked into its node_modules, and `files` written over it */
function app(files: Record<string, string> = {}, packages: Record<string, Record<string, string>> = {}): string {
  const root = join(tmp, `app-${n++}`);
  cpSync(resolve(__dirname, 'fixtures/ui-app'), root, { recursive: true });
  mkdirSync(join(root, 'node_modules/@fixture'), { recursive: true });
  symlinkSync(UI, join(root, 'node_modules/@fixture/ui'), 'dir');
  for (const [f, s] of Object.entries(files)) { mkdirSync(join(root, f, '..'), { recursive: true }); writeFileSync(join(root, f), s); }
  for (const [name, pkg] of Object.entries(packages)) {
    for (const [f, s] of Object.entries(pkg)) { mkdirSync(join(root, 'node_modules', name, f, '..'), { recursive: true }); writeFileSync(join(root, 'node_modules', name, f), s); }
  }
  return root;
}
const page = (body: string) => `<!doctype html><html><head><title>t</title></head><body>${body}</body></html>`;
/** compiles a page of the app as the build does */
function build(root: string, html: string, options: ProjectOptions = { components: ['@fixture/ui'] }, more: { check?: boolean } = {}) {
  const p = project(root, options);
  const file = join(root, 'index.html');
  writeFileSync(file, html);
  const out = compile(html, { file, root, dev: false, helpers: p.helpers, actions: p.actions, readFile: p.readFile, componentNames: p.componentNames, libraries: p.libraries, ...(more.check ? { check: true } : {}) });
  return { p, out, diagnostics: [...p.diagnostics, ...out.diagnostics] };
}
const codes = (ds: Diagnostic[]) => ds.map((d) => d.code);
const pkgJson = (o: object) => JSON.stringify({ version: '1.0.0', type: 'module', peerDependencies: { '@tiaforge-ui/sinter': '*' }, ...o });

describe('the packages', () => {
  test('found from the config: the app-shaped folder, the prefix, public and internal components, files read through the link', () => {
    const root = app();
    const p = project(root, { components: ['@fixture/ui'] });
    expect(p.diagnostics).toEqual([]);
    const [l] = p.libraries;
    expect([l!.name, l!.prefix, l!.public, l!.internal]).toEqual(['@fixture/ui', 'ui', ['ui-card', 'ui-tree'], ['ui-node']]);
    expect(l!.dir).toBe(join(root, 'node_modules/@fixture/ui'));
    expect(l!.real).toBe(UI);
    // ComponentName: the app's components and the libraries' public ones
    expect(p.componentNames).toEqual(['app-frame', 'ui-card', 'ui-tree']);
    // a library's file is read although its real path is outside the root; other files outside it are not
    expect(p.readFile(join(l!.folder, 'components/ui-card.html'))).toContain('data-sn-component');
    expect(p.readFile(join(UI, 'sinter/components/internal/ui-node.html'))).toContain('ui-node');
    expect(() => p.readFile(resolve(__dirname, 'fixtures/contacts.html'))).toThrow(/outside the project root/);
  });

  test('helpers: the app re-exports a package as a namespace, followed like a relative re-export', () => {
    const p = project(app(), { components: ['@fixture/ui'] });
    // each member by the module of the package that declares it, past the package's entry
    const at = (f: string) => ({ module: `/node_modules/@fixture/ui/sinter/${f}`, name: '' });
    expect(p.helpers.namespaces.ui).toEqual({ module: '@fixture/ui', members: ['count', 'initials', 'outline', 'words'], from: {
      count: { ...at('sinter.helpers.ts'), name: 'count' }, initials: { ...at('sinter.helpers.ts'), name: 'initials' },
      outline: { ...at('outline.ts'), name: 'outline' }, words: { ...at('parse.ts'), name: 'words' },
    } });
    expect(p.helpers.names).toEqual(['shout']);
    // without the package in `components`, it is not followed
    expect(project(app(), {}).helpers.namespaces.ui!.members).toEqual([]);
  });

  test('SN337: not installed, no "sinter" folder, no components/, a component in both folders, names that do not share a prefix', () => {
    const root = app({}, {
      '@t/plain': { 'package.json': pkgJson({ name: '@t/plain' }) },
      '@t/empty': { 'package.json': pkgJson({ name: '@t/empty', sinter: './sinter' }), 'sinter/sinter.types.ts': '' },
      '@t/both': { 'package.json': pkgJson({ name: '@t/both', sinter: './s' }), 's/components/b-x.html': '<template data-sn-component=""><p></p></template>', 's/components/internal/b-x.html': '<template data-sn-component=""><p></p></template>' },
      '@t/mixed': { 'package.json': pkgJson({ name: '@t/mixed', sinter: './s' }), 's/components/m-a.html': '<template data-sn-component=""><p></p></template>', 's/components/m-b.html': '<template data-sn-component=""><p></p></template>', 's/components/internal/q-c.html': '<template data-sn-component=""><p></p></template>' },
      '@t/out': { 'package.json': pkgJson({ name: '@t/out', sinter: '../x' }) },
    });
    const ds = project(root, { components: ['@t/missing', '@t/plain', '@t/empty', '@t/both', '@t/mixed', '@t/out'] }).diagnostics;
    expect(codes(ds)).toEqual(['SN337', 'SN337', 'SN337', 'SN337', 'SN337', 'SN337']);
    expect(ds[0]!.message).toMatch(/`@t\/missing` is in `sinter\(\{ components \}\)` and is not installed/);
    expect(ds[1]!.message).toMatch(/`@t\/plain` .* has no `"sinter"` field/);
    expect(ds[2]!.message).toMatch(/`@t\/empty`: its `"sinter"` folder \(`\.\/sinter`\) has no `components\/` folder/);
    expect(ds[3]!.message).toMatch(/`b-x` is both in `components\/` and `components\/internal\/`/);
    expect(ds[4]!.message).toMatch(/`@t\/mixed`: a library's component names share their first segment, the prefix it owns; `q-c` does not start with `m-`/);
    expect(ds[4]!.file).toMatch(/s\/components\/internal\/q-c\.html$/);
    expect(ds[5]!.message).toMatch(/is outside the package/);
  });

  test('SN338: a prefix belongs to one package, and an app component cannot take a library\'s prefix', () => {
    const root = app({ 'src/components/ui-button.html': '<template data-sn-component=""><button></button></template>' }, {
      '@t/other': { 'package.json': pkgJson({ name: '@t/other', sinter: './sinter' }), 'sinter/components/ui-box.html': '<template data-sn-component=""><div></div></template>' },
    });
    const ds = project(root, { components: ['@fixture/ui', '@t/other'] }).diagnostics;
    expect(ds.map((d) => [d.code, d.message.split(':')[0]])).toEqual([
      ['SN338', '`@t/other` and `@fixture/ui` both name their components `ui-…`'],
      ['SN338', '`<ui-button>` starts with `ui-`, the prefix of `@fixture/ui` (`sinter({ components })`)'],
    ]);
    expect(ds[1]!.file).toBe(join(root, 'src/components/ui-button.html'));
    expect(ds[1]!.hint).toMatch(/rename it \(`app-button`\)/);
  });

  test('SN537: the sinter versions a library supports, from its peerDependencies', () => {
    const v = sinterVersion()!;
    expect(v).toMatch(/^\d+\.\d+\.\d+/);
    const root = app({}, {
      '@t/none': { 'package.json': JSON.stringify({ name: '@t/none', sinter: './s' }), 's/components/n-a.html': '<template data-sn-component=""><p></p></template>' },
      '@t/old': { 'package.json': JSON.stringify({ name: '@t/old', sinter: './s', peerDependencies: { '@tiaforge-ui/sinter': '^0.1.0' } }), 's/components/o-a.html': '<template data-sn-component=""><p></p></template>' },
    });
    const ds = project(root, { components: ['@fixture/ui', '@t/none', '@t/old'] }).diagnostics;
    expect(ds.map((d) => [d.code, d.severity])).toEqual([['SN537', 'warning'], ['SN537', 'warning']]);
    expect(ds[0]!.message).toMatch(/`@t\/none` does not say which sinter versions it supports/);
    expect(ds[1]!.message).toBe(`\`@t/old\` supports sinter \`^0.1.0\`, and this is sinter ${v}: its markup may use what this version does not have, or what it no longer has`);
  });

  test('version ranges, as npm writes them', () => {
    const yes: Array<[string, string]> = [['0.18.0', '^0.18.0'], ['0.18.4', '~0.18.1'], ['1.4.0', '^1.2.0'], ['0.18.0', '>=0.18.0 <1'], ['0.18.0', '0.x'], ['2.0.0', '1 - 2'], ['0.18.0', '^0.17.0 || ^0.18.0'], ['0.18.0', '*'], ['0.18.0', '0.18'], ['0.0.3', '^0.0.3']];
    const no: Array<[string, string]> = [['0.18.0', '^0.17.0'], ['0.19.0', '~0.18.1'], ['2.0.0', '^1.2.0'], ['1.0.0', '>=0.18.0 <1'], ['3.0.0', '1 - 2'], ['0.0.4', '^0.0.3'], ['0.18.0', '>0.18']];
    for (const [v, r] of yes) expect(satisfies(v, r), `${v} in ${r}`).toBe(true);
    for (const [v, r] of no) expect(satisfies(v, r), `${v} not in ${r}`).toBe(false);
  });
});

describe('the components', () => {
  test('a page uses public components and a tree with a fill; the scripts, styles and layer', () => {
    const { diagnostics, out } = build(app(), readFileSync(resolve(__dirname, 'fixtures/ui-app/index.html'), 'utf8'));
    expect(diagnostics).toEqual([]);
    expect(out.html).toContain('<section class="card" data-sn="1" data-sn-c="ui-card">');
    expect(out.html).toContain('<button class="pick" data-sn-s=""></button>');
    expect(out.html).toMatch(/<li data-sn-c="ui-node">/);
  });

  test('SN339: the app using an internal component names the public ones; a name in a library\'s prefix that it does not have', () => {
    const root = app({ 'src/components/app-list.html': '<template data-sn-component=""><ul><ui-node data-sn-prop="{ item: { id: 1, label: \'x\' } }"></ui-node></ul></template>' });
    const internal = build(root, page('<ui-node data-sn-prop="{ item: { id: 1, label: \'x\' } }"></ui-node><app-list></app-list>')).diagnostics;
    expect(internal.map((d) => [d.code, d.message, d.hint, d.file.slice(root.length + 1), d.line])).toEqual([
      ['SN339', '`<ui-node>` is internal to `@fixture/ui` (`components/internal/`): only its own components use it', 'its public components: `<ui-card>`, `<ui-tree>`', 'index.html', 1],
      ['SN339', '`<ui-node>` is internal to `@fixture/ui` (`components/internal/`): only its own components use it (included from index.html:1)', 'its public components: `<ui-card>`, `<ui-tree>`', 'src/components/app-list.html', 1],
    ]);
    const unknown = build(root, page('<ui-crd></ui-crd>')).diagnostics;
    expect(unknown.map((d) => [d.code, d.message, d.hint])).toEqual([['SN339', '`<ui-crd>` is not a component of `@fixture/ui`, which owns the prefix `ui-`', ' Did you mean `ui-card`? its public components: `<ui-card>`, `<ui-tree>`'.trim()]]);
    // internal through a map in `<sn-component use>`, and a fill (the app's markup) inside a library's root
    const map = build(root, page(`<div data-sn-state="{ t: 'a' }"><sn-component use="{ a: 'ui-node', b: 'ui-card' }[t]" data-sn-prop="{ title: 'x' }"></sn-component>
      <ui-tree data-sn-prop="{ items: [] }"><span slot="node"><ui-node data-sn-prop="{ item: $slot.item }"></ui-node></span></ui-tree></div>`)).diagnostics;
    expect(codes(map)).toEqual(['SN339', 'SN339']);
    expect(map[0]!.message).toBe('`\'ui-node\'` is internal to `@fixture/ui` (`components/internal/`): only its own components use it');
  });

  test('a diagnostic in a library\'s file names the file in the package, then where the app uses it', () => {
    const root = app();
    const lib = join(tmp, `lib-${n++}`);
    cpSync(UI, lib, { recursive: true });
    writeFileSync(join(lib, 'sinter/components/internal/ui-node.html'), readFileSync(join(UI, 'sinter/components/internal/ui-node.html'), 'utf8').replace('<li>', '<li data-sn-txt="1">'));
    rmSync(join(root, 'node_modules/@fixture/ui'));
    symlinkSync(lib, join(root, 'node_modules/@fixture/ui'), 'dir');
    const ds = build(root, page('\n\n<div data-sn-state="{ items: [] }">\n<ui-tree data-sn-prop="{ items }"></ui-tree></div>')).diagnostics;
    const d = ds.find((x) => x.code === 'SN101')!;
    expect(d.message).toMatch(/ … used at index\.html:4$/);
    expect(formatDiagnostic(d)).toMatch(/^@fixture\/ui\/sinter\/components\/internal\/ui-node\.html:2:\d+ error SN101 unknown-attribute: .* … used at index\.html:4\n/);
  });

  test('`<sn-component use>`: in the app\'s markup, the app\'s and the public components; in a library\'s, its own, internal ones included (rule 7)', () => {
    const kit = {
      'package.json': pkgJson({ name: '@t/kit', sinter: './sinter' }),
      'sinter/components/kit-list.html': '<template data-sn-component="{ kinds: string[] }"><ul><template data-sn-for="k in kinds"><li><sn-component use="`kit-${k}-row`" data-sn-prop="{}"></sn-component></li></template></ul></template>',
      'sinter/components/kit-a-row.html': '<template data-sn-component=""><b>a</b></template>',
      'sinter/components/internal/kit-b-row.html': '<template data-sn-component=""><i>b</i></template>',
    };
    const root = app({ 'src/components/app-c-row.html': '<template data-sn-component=""><u>c</u></template>' }, { '@t/kit': kit });
    const o = { components: ['@fixture/ui', '@t/kit'] };
    const r = build(root, page('<kit-list data-sn-prop="{ kinds: [\'a\', \'b\'] }"></kit-list><div data-sn-state="{ k: \'a\' }"><sn-component use="`kit-${k}-row`" data-sn-prop="{}"></sn-component><sn-component use="`app-${k}-row`" data-sn-prop="{}"></sn-component></div>'), o);
    expect(r.diagnostics).toEqual([]);
    // the library's list renders its internal row; the page's choice has the public row only, the app's its own
    expect(r.out.html).toContain('<i>b</i>');
    const ids = [...r.out.html.matchAll(/<template id="sn-t-\d+">\s*<(\w+)/g)].map((m) => m[1]);
    expect(ids.filter((t) => t === 'i').length).toBe(1);
    // a map in a library's markup names only its own components
    const bad = { ...kit, 'sinter/components/kit-list.html': '<template data-sn-component="{ k: string }"><div><sn-component use="{ a: \'kit-a-row\', c: \'app-c-row\' }[k]" data-sn-prop="{}"></sn-component></div></template>' };
    const r2 = build(app({ 'src/components/app-c-row.html': '<template data-sn-component=""><u>c</u></template>' }, { '@t/kit': bad }), page('<kit-list data-sn-prop="{ k: \'a\' }"></kit-list>'), o);
    expect(r2.diagnostics.map((d) => [d.code, d.message.split(':')[0]])).toEqual([['SN339', '`\'app-c-row\'` is not a component of `@t/kit`']]);
  });
});

describe('tree slots across packages', () => {
  // `kit-tree` (a root that declares `leaf`) and `kit-leaf` (its tree placement) in one package
  const kit = (more: Record<string, string> = {}) => ({
    'package.json': pkgJson({ name: '@t/kit', sinter: './sinter' }),
    'sinter/components/kit-tree.html': '<template data-sn-component="{ n: number; leaf: Slot<{ n: number }> }"><div class="tree"><kit-leaf data-sn-prop="{ n }"></kit-leaf></div></template>',
    'sinter/components/kit-leaf.html': '<template data-sn-component="{ n: number }"><slot name="leaf" data-sn-prop="{ n }"><b class="default" data-sn-text="n"></b></slot></template>',
    ...more,
  });
  const o = { components: ['@fixture/ui', '@t/kit'] };

  test('rule 2: a placement is filled by the nearest root of its own package; an app component that declares the name is not one', () => {
    const root = app({ 'src/components/app-wrap.html': '<template data-sn-component="{ leaf: Slot<{ n: number }> }"><section><kit-leaf data-sn-prop="{ n: 1 }"></kit-leaf><slot name="leaf" data-sn-prop="{ n: 0 }"><i></i></slot></section></template>' }, { '@t/kit': kit() });
    const ds = build(root, page('<app-wrap><em slot="leaf">x</em></app-wrap>'), o).diagnostics;
    expect(ds.map((d) => [d.code, d.message])).toEqual([['SN331', '`<kit-leaf>` places the slot `leaf` (`<slot name="leaf" data-sn-prop>`), and no component around it declares `leaf`: nothing can fill it here (included from index.html:1)']]);
    // within its package, the root fills it
    const ok = build(app({}, { '@t/kit': kit() }), page('<kit-tree data-sn-prop="{ n: 3 }"><em slot="leaf" class="fill" data-sn-text="$slot.n"></em></kit-tree>'), o);
    expect(ok.diagnostics).toEqual([]);
    expect(ok.out.html).toMatch(/<div class="tree"><em class="fill"[^>]*><\/em><\/div>/);
  });

  test('rule 3: a root written in another package\'s markup starts a new contract; outer fills do not reach into it', () => {
    // an app component that declares `leaf` and uses the library's root inside: the page's fill is app-wrap's, not kit-tree's
    const root = app({ 'src/components/app-wrap.html': '<template data-sn-component="{ leaf: Slot<{ n: number }> }"><section><kit-tree data-sn-prop="{ n: 5 }"></kit-tree><slot name="leaf" data-sn-prop="{ n: 0 }"><i></i></slot></section></template>' }, { '@t/kit': kit() });
    const r = build(root, page('<app-wrap><em slot="leaf" class="fill" data-sn-text="$slot.n"></em></app-wrap>'), o);
    expect(r.diagnostics).toEqual([]);
    // kit-tree shows its default; the fill renders at app-wrap's own placement only
    expect(r.out.html).toMatch(/<section><div class="tree"><b class="default"[^>]*><\/b><\/div><em class="fill"[^>]*><\/em><\/section>/);
  });

  test('rule 1 and 4 within a package: a root inside another root of its package takes the outer fill', () => {
    const k = kit({ 'sinter/components/kit-pair.html': '<template data-sn-component="{ leaf: Slot<{ n: number }> }"><div class="pair"><kit-tree data-sn-prop="{ n: 7 }"></kit-tree></div></template>' });
    const r = build(app({}, { '@t/kit': k }), page('<kit-pair><em slot="leaf" class="fill" data-sn-text="$slot.n"></em></kit-pair>'), o);
    expect(r.diagnostics).toEqual([]);
    expect(r.out.html).toMatch(/<div class="pair"><div class="tree"><em class="fill"[^>]*><\/em><\/div><\/div>/);
  });

  test('rule 5: a declared slot that nothing of its package places', () => {
    const k = kit({ 'sinter/components/kit-lone.html': '<template data-sn-component="{ cell: Slot<{ n: number }> }"><div></div></template>' });
    const ds = build(app({}, { '@t/kit': k }), page('<kit-lone></kit-lone>'), o).diagnostics;
    expect(ds.map((d) => [d.code, d.message.split(':')[0], d.file.replace(/^.*node_modules\//, '')])).toEqual([['SN331', '`<kit-lone>` declares the slot `cell`, and nothing inside it places `cell`', '@t/kit/sinter/components/kit-lone.html']]);
  });

  test('rule 7: the helper form of `<sn-component use>` in a library component with slots', () => {
    const k = kit({ 'sinter/components/kit-any.html': '<template data-sn-component="{ leaf: Slot<{ n: number }>; c: string }"><div><sn-component use="pick(c)" data-sn-prop="{ n: 1 }"></sn-component></div></template>' });
    const ds = build(app({}, { '@t/kit': k }), page('<kit-any data-sn-prop="{ c: \'kit-leaf\' }"></kit-any>'), o).diagnostics;
    expect(ds.map((d) => [d.code, d.message.split(',')[0]])).toEqual([['SN312', '`<kit-any>` declares slots']]);
  });
});

describe('types', () => {
  const typecheck = (root: string, html: string) => {
    const { p, out, diagnostics } = build(root, html, { components: ['@fixture/ui'] }, { check: true });
    const r = check({ root, units: out.check ? [out.check] : [], helpers: p.helpers, actions: p.actions, types: p.types, openapi: p.openapi, tsc: findTsc(process.cwd()), messagesTypes: p.messagesTypes, libraries: p.libraries });
    return [...diagnostics, ...r.diagnostics];
  };

  test('a library\'s props and slot data resolve type names against its own types module', () => {
    const root = app();
    // `Tone` is only the library's: the app's types module re-exports `Item` and nothing else
    expect(typecheck(root, readFileSync(resolve(__dirname, 'fixtures/ui-app/index.html'), 'utf8'))).toEqual([]);
    const bad = typecheck(root, page(`<ui-card data-sn-prop="{ title: 'x', tone: 'quiet' }"></ui-card>
<div data-sn-state="{ items: [{ id: 1, label: 'a' }] }"><ui-tree data-sn-prop="{ items }"><b slot="node" data-sn-text="$slot.item.lable"></b></ui-tree></div>`));
    // (a fill compiled for each depth of the tree reports its error once per depth, as among app components)
    const distinct = [...new Map(bad.map((d) => [`${d.file}:${d.line}:${d.col}:${d.message}`, d])).values()];
    expect(distinct.map((d) => [d.code, d.message])).toEqual([
      ['SN208', 'Type \'"quiet"\' is not assignable to type \'Tone\'. (TS2322)'],
      ['SN208', 'Property \'lable\' does not exist on type \'Item\'. Did you mean \'label\'? (TS2551)'],
    ]);
  }, 60_000);

  test('the generated declarations: ComponentName with the public components, the base class of a library\'s script typed by its types module', () => {
    const root = app();
    const p = project(root, { components: ['@fixture/ui'] });
    const d = readFileSync(p.componentsTypes!, 'utf8');
    expect(d).toContain('type ComponentName = "app-frame" | "ui-card" | "ui-tree";');
    expect(d).toContain(`declare module '*/ui-card.html' {\n  type Tone = import('../node_modules/@fixture/ui/sinter/sinter.types').Tone;`);
    expect(d).toContain('export class UiCardComponent extends Base<{ title: string; tone?: Tone }');
    expect(d).toContain('the base of `@fixture/ui/sinter/components/ui-card.ts`');
  });
});

test('a package imports itself by its name through its own `exports` (Node\'s self-reference), in the resolver that the manifest, the fold check and the lazy walk share', async () => {
  const { resolveImport, foldVerdicts } = await import('../src/fold-check.js');
  const lib = join(tmp, `self-${n++}`);
  cpSync(UI, lib, { recursive: true });
  const from = join(lib, 'src/sinter.helpers.ts');
  expect(resolveImport('@fixture/ui', from, lib)).toBe(join(lib, 'sinter/index.ts'));
  // a subpath its `exports` does not give is not resolved
  expect(resolveImport('@fixture/ui/sinter/outline.ts', from, lib)).toBe(null);
  // without `exports`, a package cannot import itself: node_modules as before
  const bare = join(tmp, `bare-${n++}`);
  mkdirSync(join(bare, 'src'), { recursive: true });
  writeFileSync(join(bare, 'package.json'), JSON.stringify({ name: 'bare-pkg', main: 'index.js' }));
  writeFileSync(join(bare, 'index.js'), 'export const x = 1;\n');
  expect(resolveImport('bare-pkg', join(bare, 'src/a.ts'), bare)).toBe(null);
  const p = project(lib, (await viteProject(lib)).options);
  const v = foldVerdicts(p.helpers, lib, p.helpersFile);
  expect(v.get('ui$outline')).toMatchObject({ fold: true });
  const lh = lazyHelpers(lib, ['@fixture/heavy'], undefined, p.libraries);
  expect(lh.reach('/sinter/parse.ts')).toEqual(['@fixture/heavy']);
  expect(lh.reach('@fixture/ui')).toEqual([]);
});

describe('the library author\'s check', () => {
  const cli = (root: string) => spawnSync(process.execPath, [resolve(__dirname, '../node_modules/jiti/lib/jiti-cli.mjs'), resolve(__dirname, '../src/cli.ts'), 'check', '--root', root], { encoding: 'utf8', env: { ...process.env, SINTER_STRICT: '' } });

  test('in the library\'s repository, its fixture pages are the pages, and the library is configured', async () => {
    const lib = join(tmp, `repo-${n++}`);
    cpSync(UI, lib, { recursive: true });
    const v = await viteProject(lib);
    expect(v.pages).toEqual([join(lib, 'fixtures/helpers.html'), join(lib, 'fixtures/index.html')]);
    expect(v.options.components).toEqual(['@fixture/ui']);
    const p = project(lib, v.options);
    expect(p.libraries.map((l) => [l.name, l.dir])).toEqual([['@fixture/ui', lib]]);
    // its script's base class is declared in its own folder
    expect(p.componentsTypes).toBe(join(lib, 'sinter/sinter.components.d.ts'));
    // its fixtures' helpers module re-exports the package by its own name: followed through its own `exports`
    expect(p.diagnostics).toEqual([]);
    expect(p.helpers.namespaces.ui!.members).toEqual(['count', 'initials', 'outline', 'words']);
    expect(p.helpers.namespaces.ui!.from!.outline).toEqual({ module: '/sinter/outline.ts', name: 'outline' });
    const r = cli(lib);
    expect(r.stdout + r.stderr).toContain('sinter check: 2 page(s), 0 error(s), 0 warning(s)');
    expect(r.status).toBe(0);
  }, 120_000);

  test('rules 5 and 7 fail it, with the library\'s file named', () => {
    const lib = join(tmp, `repo-${n++}`);
    cpSync(UI, lib, { recursive: true });
    writeFileSync(join(lib, 'sinter/components/ui-panel.html'), '<template data-sn-component="{ head: Slot<{ n: number }>; c: string }"><div><sn-component use="pick(c)" data-sn-prop="{}"></sn-component></div></template>');
    writeFileSync(join(lib, 'fixtures/panel.html'), page('<ui-panel data-sn-prop="{ c: \'ui-card\' }"></ui-panel>'));
    const r = cli(lib);
    expect(r.status).toBe(1);
    expect(r.stdout).toMatch(/sinter\/components\/ui-panel\.html:1:\d+ error SN331 invalid-slot: `<ui-panel>` declares the slot `head`, and nothing inside it places `head`/);
    expect(r.stdout).toMatch(/sinter\/components\/ui-panel\.html:1:\d+ error SN312 [\w-]+: `<ui-panel>` declares slots, so `<sn-component use>` in it names its candidates/);
  }, 120_000);
});

test('lazy helper modules: a library\'s helper module that reaches a lazy package loads whole, when a let first needs it', () => {
  const root = app({ 'src/sinter.helpers.ts': 'export * as ui from \'@fixture/ui\';\nexport * as heavy from \'@t/heavy\';\n' }, {
    '@t/heavy': {
      'package.json': pkgJson({ name: '@t/heavy', sinter: './sinter', exports: { '.': './sinter/sinter.helpers.ts' } }),
      'sinter/components/heavy-box.html': '<template data-sn-component=""><div></div></template>',
      'sinter/sinter.helpers.ts': 'import { parse } from \'bigparse\';\nexport const read = (s: string) => parse(s);\n',
    },
    bigparse: { 'package.json': JSON.stringify({ name: 'bigparse', type: 'module', main: 'index.js' }), 'index.js': 'export const parse = (s) => s;\n' },
  });
  const p = project(root, { components: ['@fixture/ui', '@t/heavy'], lazy: ['bigparse'] });
  expect(p.helpers.namespaces.heavy!.members).toEqual(['read']);
  const lh = lazyHelpers(root, p.lazy, undefined, p.libraries);
  expect(lh.reach('@t/heavy')).toEqual(['bigparse']);
  expect(lh.reach('@fixture/ui')).toEqual([]);
  const whole = lh.whole(p.helpers);
  expect([...whole].some((f) => f.endsWith('@t/heavy/sinter/sinter.helpers.ts'))).toBe(true);
  // a page calls it in a let: it waits for the module
  const file = join(root, 'index.html');
  const html = page('<div data-sn-state="{ s: \'x\' }"><p data-sn-let="{ v: heavy.read(s) }" data-sn-text="v"></p></div>');
  const out = compile(html, { file, root, dev: false, helpers: p.helpers, actions: p.actions, readFile: p.readFile, componentNames: p.componentNames, libraries: p.libraries, lazy: p.lazy, lazyModule: lh.reach });
  expect(out.diagnostics).toEqual([]);
  expect(out.module).toMatch(/import\(["']@t\/heavy["']\)/);
});

test('`sinter render` finds a library component\'s script and runs it', async () => {
  const { parseRenderArgs, renderPage } = await import('../src/render-cli.js');
  // the options as the Vite config gives them (the plugin's `api.options`)
  const root = app({ 'vite.config.mjs': 'export default { plugins: [{ name: \'sinter\', api: { options: { components: [\'@fixture/ui\'] } } }] };\n' });
  const a = parseRenderArgs(['index.html'], root);
  if (typeof a === 'string') throw new Error(a);
  const r = await renderPage(a);
  expect(r.rendered).toContain('data-ready="ADA LOVELACE"');
  expect(r.rendered).toMatch(/<button class="pick"[^>]*>root<\/button>/);
}, 60_000);

describe('a package namespace by its declaring modules (section 8\'s per-module rule)', () => {
  // `outline` needs only the tree; `words` reaches `@fixture/heavy`, lazy in this app; one namespace re-exports both
  const o = { components: ['@fixture/ui'], lazy: ['@fixture/heavy'] };
  const compileLazy = (root: string, html: string) => {
    const p = project(root, o);
    const file = join(root, 'index.html');
    const lh = lazyHelpers(root, p.lazy, undefined, p.libraries);
    return compile(html, { file, root, dev: false, helpers: p.helpers, actions: p.actions, readFile: p.readFile, componentNames: p.componentNames, libraries: p.libraries, lazy: p.lazy, lazyModule: lh.reach });
  };

  test('the lazy rule per module: the plain member is an ordinary helper, the one that reaches the lazy package waits', () => {
    const root = app();
    const p = project(root, o);
    const lh = lazyHelpers(root, p.lazy, undefined, p.libraries);
    expect(lh.reach('@fixture/ui')).toEqual([]);
    expect(lh.reach('/node_modules/@fixture/ui/sinter/outline.ts')).toEqual([]);
    expect(lh.reach('/node_modules/@fixture/ui/sinter/parse.ts')).toEqual(['@fixture/heavy']);
    const out = compileLazy(root, page(`<div data-sn-state="{ items: [{ id: 1, label: 'a' }], s: 'one two' }">
      <p id="o" data-sn-text="ui.outline(items).join(', ')"></p>
      <p data-sn-let="{ w: ui.words(s) }" data-sn-text="w?.length"></p></div>`));
    expect(out.diagnostics).toEqual([]);
    // the plain member from its own module; the other module loads when the let first needs it
    expect(out.module).toContain('outline as ui$outline } from "/node_modules/@fixture/ui/sinter/outline.ts"');
    expect(out.module).toMatch(/import\("\/node_modules\/@fixture\/ui\/sinter\/parse\.ts"\)/);
    expect(out.module).not.toMatch(/from "\/node_modules\/@fixture\/ui\/sinter\/parse\.ts"|from "@fixture\/ui"/);
  });

  test('the lazy member in a binding is SN324; the plain one is not', () => {
    const ds = compileLazy(app(), page('<div data-sn-state="{ s: \'x\' }"><p data-sn-text="ui.words(s)"></p></div>')).diagnostics;
    expect(ds.map((d) => d.code)).toEqual(['SN324']);
  });

  test('the fold check per module: the plain member folds, the other is judged by its own module', async () => {
    const { foldVerdicts } = await import('../src/fold-check.js');
    const root = app();
    const p = project(root, o);
    const v = foldVerdicts(p.helpers, root, p.helpersFile);
    expect(v.get('ui$outline')).toMatchObject({ fold: true });
    expect(v.get('ui$initials')).toMatchObject({ fold: true });
    // `words` is judged by its own module, which reaches the package's top-level code (and, being lazy, never runs at build time anyway)
    expect(v.get('ui$words')).toMatchObject({ fold: false, reason: '`globalThis`' });
  });
});
