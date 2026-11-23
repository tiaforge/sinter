// The type check's diagnostics corpus (docs/proposals/redesign-notes/typecheck.md, "The diagnostics corpus";
// stage4-check-once.md): apps whose type errors sit everywhere a component's markup can be checked from, built with
// Vite (the build's error text) and checked with `sinter check` (its stdout, stderr and exit code), and a clean app
// whose dist is built with the check on and off. Everything is written to one text file, paths shortened to `<app>`,
// so two checkouts (or two commits) can be compared byte for byte.
//
//   node scripts/check-corpus.mjs <out.txt> [--keep <dir>] [--only a,b]   (this repository built: `npm run build`)
//   node scripts/check-corpus.mjs --compare <ref.txt> <out.txt>
//
// The apps (on the `@fixture/ui` library of test/fixtures/ui, linked into each app's node_modules):
//   a  errors in component markup used once, twice, in loops over constants and over a resource, as a choice candidate
//      (with an SN538 candidate), with fills and data slots, in a recursive definition (three pages, two folders), in a
//      library component's props and fill, in a component reading a page resource with different types on two pages,
//      in page markup, `data-sn-with`, handlers (on the tag, `$event.detail`), and a component's `<script>` block
//   b  a plus a page with a broken expression
//   c  clean: the build passes, and its dist with the check off is compared with it on
//   d  a with an app tsconfig.json
//   e  a without a types module (the type names its components write are declared `any`)
// Each build runs in a child process with the environment it was given (SN_UNITS=0, SN_CHECK_SHARE=0, … pass through).
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { createHash } from 'node:crypto';

const REPO = resolve(import.meta.dirname, '..');
const argv = process.argv.slice(2);

if (argv[0] === '--compare') {
  const [ref, out] = [readFileSync(argv[1], 'utf8'), readFileSync(argv[2], 'utf8')];
  if (ref === out) { console.log('check-corpus: the same'); process.exit(0); }
  const a = ref.split('\n'), b = out.split('\n');
  let i = 0;
  while (a[i] === b[i]) i++;
  console.log(`check-corpus: differs at line ${i + 1}:\n  ref ${a.slice(i, i + 3).join('\n      ')}\n  now ${b.slice(i, i + 3).join('\n      ')}`);
  process.exit(1);
}

const outFile = argv[0];
if (!outFile) { console.error('usage: node scripts/check-corpus.mjs <out.txt> [--keep <dir>] [--only a,b]'); process.exit(2); }
const opt = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined; };
const keep = opt('--keep');
const only = opt('--only')?.split(',');

// ── The apps ──────────────────────────────────────────────────────────────────────────────────────────────────────
const page = (body, title = 't') => `<!doctype html>\n<html lang="en">\n<head><meta charset="utf-8"><title>${title}</title></head>\n<body>\n${body}\n</body>\n</html>\n`;

const TYPES = `export type { Item } from '@fixture/ui';
export interface Person { name: string; age: number }
export interface Para { type: 'para'; text: string }
export interface Quote { type: 'quote'; text: string }
export interface Rule { type: 'rule' }
export type Block = Para | Quote | Rule;
export interface Node { label: string; kids: Node[] }
`;
const HELPERS = "export * as ui from '@fixture/ui';\nexport const shout = (s: string): string => s.toUpperCase();\n";

/** the components of the erroneous apps: each has an error of its own (the clean app's are fixed versions) */
const COMPONENTS = (clean) => ({
  // used once, twice, in loops: a prop of the wrong member
  'x-badge.html': `<template data-sn-props="{ label: string; n: number }">
  <span class="badge"><b data-sn-text="${clean ? 'label.trim()' : 'label.toFixed(1)'}"></b><i data-sn-text="n + 1"></i></span>
</template>
`,
  // a row in a loop, with a handler and an event to its use
  'x-row.html': `<template data-sn-props="{ person: Person }" data-sn-emits="{ pick: Person }">
  <li data-sn-state="{ open: false }"><span data-sn-text="${clean ? 'person.name' : 'person.nmae'}"></span>
  <button data-sn-on-click="open = !open; emit('pick', person)" data-sn-text="${clean ? 'person.age' : 'person.age.toUpperCase()'}"></button></li>
</template>
`,
  // choice candidates
  'x-para.html': `<template data-sn-props="{ node: Para }"><p data-sn-text="${clean ? 'node.text' : 'node.txet'}"></p></template>
`,
  'x-quote.html': `<template data-sn-props="{ node: Quote }"><blockquote data-sn-text="node.text"></blockquote></template>
`,
  // a slot that passes data, and a default fill
  'x-list.html': `<template data-sn-props="{ rows: string[]; row: Slot<{ r: string; k: number }> }">
  <ul><template data-sn-for="(r, k) in rows"><li><slot name="row" data-sn-with="{ r, k }"><span data-sn-text="${clean ? 'r' : 'r.size'}"></span></slot></li></template></ul>
</template>
`,
  // recursive: a shared definition
  'x-tree.html': `<template data-sn-props="{ node: Node; depth: number }">
  <div class="tree"><span data-sn-text="${clean ? 'node.label' : 'node.lable'}"></span><i data-sn-text="depth"></i>
  <template data-sn-for="c in node.kids"><x-tree data-sn-with="{ node: c, depth: depth + 1 }"></x-tree></template></div>
</template>
`,
  // reads the page's resource (a Person[] on one page, a string[] on another)
  'x-res.html': `<template data-sn-props="{ i: number }">
  <p data-sn-text="${clean ? 'String(people.length + i)' : 'people[i].name.toUpperCase()'}"></p>
</template>
`,
  // a fill of its own and a slot
  'x-frame.html': `<template data-sn-props="{ heading: string }">
  <div class="frame"><ui-card data-sn-with="{ title: heading }"><slot></slot></ui-card><em data-sn-text="${clean ? 'heading' : 'heading * 2'}"></em></div>
</template>
`,
  // a component with a <script> block
  'x-clock.html': `<template data-sn-props="{ at: number }">
  <time data-sn-text="at"></time>
</template>
<script lang="ts">
  import { XClockComponent } from './x-clock.html';
  export class XClock extends XClockComponent {
    connected() { const n: number = ${clean ? '1' : "'one'"}; void n; }
  }
</script>
`,
});

const TREE = "{ label: 'root', kids: [{ label: 'a', kids: [] }, { label: 'b', kids: [{ label: 'c', kids: [] }] }] }";
const BLOCKS_USE = "{ para: 'x-para', quote: 'x-quote' }[b.type]";

/** the pages of the erroneous apps; `clean` fixes every error */
const PAGES = (clean) => ({
  // a component used once and twice, in a loop over constants and over a resource
  'index.html': page(`<sn-resource name="people" src="/api/people" type="Person[]"></sn-resource>
<main data-sn-state="{ n: 1, who: 'Ada', picked: '' }">
  <x-badge data-sn-with="{ label: who, n }"></x-badge>
  <x-badge data-sn-with="{ label: ${clean ? 'who' : 'n'}, n }"></x-badge>
  <ul><template data-sn-for="x in [1, 2, 3]"><x-badge data-sn-with="{ label: 'k' + x, n: x }"></x-badge></template></ul>
  <ul><template data-sn-for="p in people"><x-row data-sn-with="{ person: p }" data-sn-on-pick="picked = ${clean ? '$event.detail.name' : '$event.detail.nmae'}"></x-row></template></ul>
  <x-res data-sn-with="{ i: 0 }"></x-res>
  <p data-sn-text="${clean ? 'who.length' : 'who.lenght'}"></p>
  <button data-sn-on-click="${clean ? 'n++' : 'n.push(1)'}">add</button>
  <x-clock data-sn-with="{ at: n }"></x-clock>
  <x-tree data-sn-with="{ node: ${TREE}, depth: 0 }"></x-tree>
</main>`),
  // choice candidates (one ruled out: SN538), fills, a data slot, the library's components
  'blocks.html': page(`<sn-resource name="blocks" src="/api/blocks" type="Block[]"></sn-resource>
<main data-sn-state="{ items: [{ id: 1, label: 'root', children: [{ id: 2, label: 'leaf' }] }], picked: 0 }">
  <template data-sn-for="b in blocks"><template data-sn-if="b.type === '${clean ? 'rule' : 'quote'}'"><q data-sn-text="${clean ? 'b.type' : 'b.text'}"></q></template><template data-sn-else><sn-component use="${BLOCKS_USE}" data-sn-with="{ node: b }"></sn-component><template data-sn-else><hr></template></template></template>
  <template data-sn-for="b in blocks"><sn-component use="${BLOCKS_USE}" data-sn-with="{ node: b }"></sn-component><template data-sn-else><hr></template></template>
  <x-list data-sn-with="{ rows: ['a', 'b'] }"><b slot="row" data-sn-text="${clean ? '$slot.r + $slot.k' : '$slot.r.toFixed()'}"></b></x-list>
  <x-list data-sn-with="{ rows: ['c'] }"></x-list>
  <x-frame data-sn-with="{ heading: 'h' }"><p data-sn-text="${clean ? 'picked' : 'picked.length'}"></p></x-frame>
  <ui-card data-sn-with="{ title: ${clean ? "'t'" : 'picked'} }"><i data-sn-text="${clean ? 'items.length' : 'items.size'}"></i></ui-card>
  <ui-tree data-sn-with="{ items }"><button slot="node" class="pick" data-sn-text="${clean ? '$slot.item.label' : '$slot.item.lable'}" data-sn-on-click="picked = $slot.item.id"></button></ui-tree>
</main>`),
  // the same in another folder (its unit placed there, its shadow beside the folder's other pages)
  get 'sub/blocks.html'() { return this['blocks.html']; },
  // the recursive component again (a shared definition on three pages, two folders), the page resource typed otherwise
  'deep.html': page(`<sn-resource name="people" src="/api/names" type="string[]"></sn-resource>
<main data-sn-state="{ d: 0 }">
  <x-tree data-sn-with="{ node: ${TREE}, depth: d }"></x-tree>
  <x-res data-sn-with="{ i: d }"></x-res>
  <x-badge data-sn-with="{ label: 'deep', n: d }"></x-badge>
</main>`),
  'sub/more.html': page(`<main data-sn-state="{ k: 2 }">
  <x-tree data-sn-with="{ node: ${TREE}, depth: k }"></x-tree>
  <x-badge data-sn-with="{ label: 'more', n: ${clean ? 'k' : "'k'"} }"></x-badge>
  <ul><template data-sn-for="s in ['x', 'y']"><li data-sn-text="${clean ? 's.length' : 's.lenght'}"></li></template></ul>
</main>`),
});

const BROKEN = page(`<main data-sn-state="{ q: 1 }"><p data-sn-text="q +"></p></main>`);
const TSCONFIG = JSON.stringify({ compilerOptions: { strict: true, target: 'es2022', module: 'esnext', moduleResolution: 'bundler', noEmit: true, allowJs: true, checkJs: true, skipLibCheck: true }, include: ['src'] }, null, 2) + '\n';

function writeApp(root, kind) {
  rmSync(root, { recursive: true, force: true });
  const clean = kind === 'c';
  const pages = { ...PAGES(clean) };
  if (kind === 'b') pages['broken.html'] = BROKEN;
  const files = {
    'package.json': JSON.stringify({ name: `corpus-${kind}`, private: true, type: 'module' }) + '\n',
    'vite.config.js': `import { resolve } from 'node:path';
import { defineConfig } from 'vite';
import sinter from '@tiaforge-ui/sinter/vite';
export default defineConfig({
  logLevel: 'silent',
  plugins: [sinter({ libraries: ['@fixture/ui'], typecheck: process.env.CORPUS_CHECK !== '0' })],
  build: { minify: false, rollupOptions: { input: Object.fromEntries(${JSON.stringify(Object.keys(pages))}.map((f) => [f.replace(/\\.html$/, ''), resolve(import.meta.dirname, f)])) } },
});
`,
    ...(kind === 'e' ? {} : { 'src/sinter.types.ts': TYPES }),
    'src/sinter.helpers.ts': HELPERS,
    ...Object.fromEntries(Object.entries(COMPONENTS(clean)).map(([f, s]) => [`src/components/${f}`, s])),
    ...pages,
    ...(kind === 'd' ? { 'tsconfig.json': TSCONFIG } : {}),
  };
  for (const [f, s] of Object.entries(files)) { mkdirSync(dirname(join(root, f)), { recursive: true }); writeFileSync(join(root, f), s); }
  mkdirSync(join(root, 'node_modules/@tiaforge-ui'), { recursive: true });
  mkdirSync(join(root, 'node_modules/@fixture'), { recursive: true });
  symlinkSync(REPO, join(root, 'node_modules/@tiaforge-ui/sinter'), 'dir');
  symlinkSync(join(REPO, 'test/fixtures/ui'), join(root, 'node_modules/@fixture/ui'), 'dir');
}

// ── Running them ──────────────────────────────────────────────────────────────────────────────────────────────────
// (the build's units, for the console: made, placed, and the pages that compiled their definitions in place, by reason)
const BUILD = `import { build } from 'vite';
import { join } from 'node:path';
const root = process.argv[1];
const { UNIT_STATS } = await import(${JSON.stringify(join(REPO, 'dist/compiler/units.js'))});
process.on('exit', () => process.stderr.write('UNITS ' + JSON.stringify({ made: UNIT_STATS.made, placed: UNIT_STATS.placed, fallback: [...UNIT_STATS.fallback] }) + '\\n'));
try { await build({ root, configFile: join(root, 'vite.config.js') }); console.log('BUILD OK'); }
catch (e) { console.log('BUILD FAILED'); console.log(String(e?.message ?? e)); }
`;
const files = (dir) => existsSync(dir) ? readdirSync(dir, { recursive: true }).map(String).filter((f) => statSync(join(dir, f)).isFile()).sort() : [];
const hashTree = (dir) => { const h = createHash('sha256'); for (const f of files(dir)) { h.update(f + '\0'); h.update(readFileSync(join(dir, f))); } return h.digest('hex').slice(0, 16); };

// (under the repository, which resolves Vite and TypeScript for them: `.sinter/` is ignored)
const base = keep ? resolve(keep) : join(REPO, '.sinter', `corpus-${process.pid}`);
const lines = [];
// (a stack's frames name this checkout's built lines: left out)
const norm = (s, root) => s.split('\n').filter((l) => !/^\s+at /.test(l)).join('\n').split(root).join('<app>').split(REPO).join('<repo>').replace(/\r\n/g, '\n').trimEnd();
const runBuild = (root, env = {}) => {
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', BUILD, root], { cwd: root, encoding: 'utf8', env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0', ...env }, maxBuffer: 1 << 28 });
  const units = /^UNITS (.*)$/m.exec(r.stderr);
  if (units) console.log(`check-corpus: ${root}: units ${units[1]}${env.CORPUS_CHECK === '0' ? ' (check off)' : ''}`);
  return norm(r.stdout + (r.status ? `\n[exit ${r.status}] ${r.stderr}` : ''), root);
};
for (const kind of only ?? ['a', 'b', 'c', 'd', 'e']) {
  const root = join(base, kind);
  writeApp(root, kind);
  lines.push(`==== app ${kind}: vite build`);
  lines.push(runBuild(root));
  if (kind === 'c') {
    const on = hashTree(join(root, 'dist'));
    rmSync(join(root, 'dist'), { recursive: true, force: true });
    const off = runBuild(root, { CORPUS_CHECK: '0' });
    const offHash = hashTree(join(root, 'dist'));
    lines.push(`==== app c: build with the check off: ${off.split('\n')[0]}; dist ${on === offHash ? 'the same' : `DIFFERS (${on} on, ${offHash} off)`} (${files(join(root, 'dist')).length} files)`);
  }
  const r = spawnSync(process.execPath, [join(REPO, 'dist/cli.js'), 'check', '--root', root], { cwd: root, encoding: 'utf8', env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0' }, maxBuffer: 1 << 28 });
  lines.push(`==== app ${kind}: sinter check: exit ${r.status}`);
  lines.push('---- stdout');
  lines.push(norm(r.stdout, root));
  lines.push('---- stderr');
  lines.push(norm(r.stderr, root));
}
writeFileSync(outFile, lines.join('\n') + '\n');
if (!keep) rmSync(base, { recursive: true, force: true });
console.log(`check-corpus: written ${outFile} (${lines.join('\n').split('\n').length} lines)`);
