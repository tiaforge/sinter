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
const check = (root: string) => spawnSync(process.execPath, [resolve(__dirname, '../node_modules/jiti/lib/jiti-cli.mjs'), resolve(__dirname, '../src/cli.ts'), 'check', '--root', root], { encoding: 'utf8', env: { ...process.env, SINTER_STRICT: '' } });

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
