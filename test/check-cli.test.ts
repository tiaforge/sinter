// `sinter check` on a project on disk, run as the command runs.
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { expect, test } from 'vitest';

function app(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'sinter-check-cli-'));
  for (const [f, text] of Object.entries(files)) { mkdirSync(join(root, f, '..'), { recursive: true }); writeFileSync(join(root, f), text); }
  symlinkSync(resolve(__dirname, '../node_modules/typescript'), join(root, 'node_modules/typescript'), 'dir');
  return root;
}
const check = (root: string, inline = false) => spawnSync(process.execPath, [resolve(__dirname, '../node_modules/jiti/lib/jiti-cli.mjs'), resolve(__dirname, '../src/cli.ts'), 'check', ...(inline ? [`--root=${root}`] : ['--root', root])], { encoding: 'utf8', env: { ...process.env, SINTER_STRICT: '' } });

test('a component\'s `.mts` script is one of the modules the lazy packages\' check walks, as a `.ts` one is (SN324)', () => {
  for (const ext of ['.ts', '.mts']) {
    const root = app({
      'package.json': '{"type":"module"}',
      'vite.config.js': `import sinter from ${JSON.stringify(resolve(__dirname, '../src/vite.ts'))};\nexport default { plugins: [sinter({ lazy: ['fakelib'] })] };\n`,
      'node_modules/fakelib/package.json': '{"name":"fakelib","type":"module","main":"index.js"}',
      'node_modules/fakelib/index.js': 'export const twice = (s) => s + s;\n',
      [`src/components/x-a${ext}`]: "import { XAComponent } from './x-a.html';\nimport './lib/setup.js';\nexport class XA extends XAComponent {}\n",
      'src/components/lib/setup.js': "import 'fakelib';\n",
      'src/components/x-a.html': '<template data-sn-props="{}"><p>a</p></template>\n',
      'index.html': '<!doctype html><html><head><title>t</title></head><body><x-a></x-a></body></html>\n',
    });
    try {
      const r = check(root);
      expect(r.stdout + r.stderr, ext).toContain('SN324');
      expect(r.stdout, ext).toContain('src/components/lib/setup.js');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
}, 60_000);

test('a single-file component\'s `<script>` is one of the modules the lazy packages\' check walks (SN324)', () => {
  const root = app({
    'package.json': '{"type":"module"}',
    'vite.config.js': `import sinter from ${JSON.stringify(resolve(__dirname, '../src/vite.ts'))};\nexport default { plugins: [sinter({ lazy: ['fakelib'] })] };\n`,
    'node_modules/fakelib/package.json': '{"name":"fakelib","type":"module","main":"index.js"}',
    'node_modules/fakelib/index.js': 'export const twice = (s) => s + s;\n',
    'src/components/x-a/x-a.html': '<template data-sn-props="{}"><p>a</p></template>\n<script lang="ts">\nimport { XAComponent } from \'./x-a.html\';\nimport \'./setup.js\';\nexport class XA extends XAComponent {}\n</script>\n',
    'src/components/x-a/setup.js': "import 'fakelib';\n",
    'index.html': '<!doctype html><html><head><title>t</title></head><body><x-a></x-a></body></html>\n',
  });
  try {
    const r = check(root);
    expect(r.stdout + r.stderr).toContain('SN324');
    expect(r.stdout).toContain('src/components/x-a/setup.js');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 60_000);

test('the lazy packages\' check follows the app\'s Vite aliases in a project without a helpers module (SN324)', () => {
  const root = app({
    'package.json': '{"type":"module"}',
    'vite.config.js': `import sinter from ${JSON.stringify(resolve(__dirname, '../src/vite.ts'))};\nimport { fileURLToPath } from 'node:url';\nexport default { resolve: { alias: { '@lib': fileURLToPath(new URL('./src/lib', import.meta.url)) } }, plugins: [sinter({ lazy: ['fakelib'] })] };\n`,
    'node_modules/fakelib/package.json': '{"name":"fakelib","type":"module","main":"index.js"}',
    'node_modules/fakelib/index.js': 'export const twice = (s) => s + s;\n',
    'src/components/x-a.ts': "import { XAComponent } from './x-a.html';\nimport '@lib/setup.js';\nexport class XA extends XAComponent {}\n",
    'src/lib/setup.js': "import 'fakelib';\n",
    'src/components/x-a.html': '<template data-sn-props="{}"><p>a</p></template>\n',
    'index.html': '<!doctype html><html><head><title>t</title></head><body><x-a></x-a></body></html>\n',
  });
  try {
    // (`--root=dir` as `--root dir`, as every command takes its flags)
    const r = check(root, true);
    expect(r.stdout).toContain('SN324');
    expect(r.stdout).toContain('src/lib/setup.js');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 60_000);

test('a single-file component: its `<script lang="ts">` is type-checked, imports beside the file resolve, errors at the file\'s line and column (SN208)', () => {
  const html = (body: string) => `<template data-sn-props="{ n: number }">
  <p data-sn-text="n"></p>
</template>

<script lang="ts">
  import { XAComponent } from './x-a.html';
  import { twice } from './math.js';
  export class XA extends XAComponent {
${body}
  }
</script>
`;
  const root = app({
    'package.json': '{"type":"module"}',
    'node_modules/.keep': '',
    'src/components/x-a/math.ts': 'export const twice = (n: number): number => n * 2;\n',
    'src/components/x-a/x-a.html': html("    connected() { const d: number = twice(2); void d; }"),
    'index.html': '<!doctype html><html><head><title>t</title></head><body><x-a data-sn-with="{ n: 1 }"></x-a></body></html>\n',
  });
  try {
    const ok = check(root);
    expect(ok.stdout + ok.stderr).not.toContain('SN208');
    writeFileSync(join(root, 'src/components/x-a/x-a.html'), html("    connected() { const d: string = twice('2'); void d; }"));
    const r = check(root);
    // `twice('2')`: line 9, at the argument; its result is not a string, at `d`
    expect(r.stdout).toMatch(/src\/components\/x-a\/x-a\.html:9:43 error SN208[^\n]*Argument of type 'string' is not assignable to parameter of type 'number'/);
    expect(r.stdout).toMatch(/src\/components\/x-a\/x-a\.html:9:25 error SN208[^\n]*Type 'number' is not assignable to type 'string'/);
    expect(r.status).toBe(1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 60_000);

test('a single-file component\'s `<script>` is checked under the app\'s tsconfig, as the same code in a module beside its file: its strictness, `paths` and declaration files (SN208)', () => {
  const html = (lang: string, body: string) => `<template data-sn-props="{ n: number }">
  <p data-sn-text="n"></p>
</template>

<script${lang}>
  import { XAComponent } from './x-a.html';
  import { twice } from '@lib/math';
  export class XA extends XAComponent {
    connected() {
${body}
    }
  }
</script>
`;
  const body = "      const el: HTMLElement = document.querySelector('h1'); const f = (x) => x * twice(2); void el; void f;\n      const mode: string = import.meta.env.VITE_MODE; void mode;";
  const root = app({
    'package.json': '{"type":"module"}',
    'node_modules/.keep': '',
    'tsconfig.base.json': JSON.stringify({ compilerOptions: { strict: true, outDir: 'dist', rootDir: 'src', composite: true, declaration: true } }),
    'tsconfig.json': '// the app\'s, with comments\n' + JSON.stringify({ extends: './tsconfig.base.json', compilerOptions: { target: 'ESNext', module: 'ESNext', moduleResolution: 'bundler', lib: ['ESNext', 'DOM'], verbatimModuleSyntax: true, isolatedModules: true, paths: { '@lib/*': ['./src/lib/*'] } }, include: ['src'] }),
    'src/env.d.ts': 'interface ImportMetaEnv { readonly VITE_MODE: string }\ninterface ImportMeta { readonly env: ImportMetaEnv }\n',
    'src/lib/math.ts': 'export const twice = (n: number): number => n * 2;\n',
    // an error in a module of the app's own is its tsc's to report
    'src/lib/other.js': 'export const bad = 1;\nbad.nope();\n',
    'src/components/x-a/x-a.html': html(' lang="ts"', body),
    'index.html': '<!doctype html><html><head><title>t</title></head><body><x-a data-sn-with="{ n: 1 }"></x-a></body></html>\n',
  });
  try {
    const r = check(root);
    // `document.querySelector('h1')` may be null, `x` is implicitly any: as the app's tsc says of the same code
    expect(r.stdout).toMatch(/src\/components\/x-a\/x-a\.html:10:13 error SN208[^\n]*Type 'HTMLHeadingElement \| null' is not assignable to type 'HTMLElement'[^\n]*\(TS2322\)/);
    expect(r.stdout).toMatch(/src\/components\/x-a\/x-a\.html:10:72 error SN208[^\n]*Parameter 'x' implicitly has an 'any' type[^\n]*\(TS7006\)/);
    expect(r.stdout.match(/ SN208 /g)).toHaveLength(2);
    expect(r.stdout).not.toContain('other.js');
    // a JS `<script>` is checked whatever the app's `checkJs`, its imports of the app's JS are not
    writeFileSync(join(root, 'src/components/x-a/x-a.html'), html('', "      import('../../lib/other.js'); const n = 1; n.nope();"));
    const js = check(root);
    expect(js.stdout).toMatch(/x-a\.html:10:\d+ error SN208[^\n]*Property 'nope' does not exist on type '1'/);
    expect(js.stdout.match(/ SN208 /g)).toHaveLength(1);
    // without a tsconfig: sinter's own options, as before (nulls and implicit anys pass)
    rmSync(join(root, 'tsconfig.json'));
    writeFileSync(join(root, 'src/components/x-a/x-a.html'), html(' lang="ts"', "      const el: HTMLElement = document.querySelector('h1'); const f = (x) => x * 2; void el; void f;").replace("import { twice } from '@lib/math';", ''));
    const lax = check(root);
    expect(lax.stdout + lax.stderr).not.toContain('SN208');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 60_000);
