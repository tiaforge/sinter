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
