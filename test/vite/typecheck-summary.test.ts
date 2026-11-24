// @vitest-environment node
// The build's type check (`sinter({ typecheck })`, docs/type-checking.md): it fails the build on type errors, and its
// line counts errors and warnings apart, as `sinter check`'s does; a warning alone (SN538) is printed and does not
// fail it (redesign-notes/bugs.md, bug 5).
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { build } from 'vite';
import { afterAll, expect, test, vi } from 'vitest';
import sinter from '../../src/vite.js';

const src = resolve(__dirname, '../../src');
const alias = [{ find: /^@tiaforge-ui\/sinter\/runtime$/, replacement: `${src}/runtime-entry.ts` }, { find: /^@tiaforge-ui\/sinter\/(?:runtime\/)?(.+)$/, replacement: `${src}/$1.ts` }, { find: /^@tiaforge-ui\/sinter$/, replacement: `${src}/index.ts` }];
const tmp = mkdtempSync(join(tmpdir(), 'sinter-typecheck-summary-'));
// (the apps are outside the repository: the check finds TypeScript from the app's root, as content.test.ts's do)
mkdirSync(join(tmp, 'node_modules'));
symlinkSync(resolve(__dirname, '../../node_modules/typescript'), join(tmp, 'node_modules/typescript'), 'dir');
afterAll(() => rmSync(tmp, { recursive: true, force: true }));
let n = 0;

async function run(extra: string, strict = false) {
  const root = join(tmp, `app-${n++}`);
  const files: Record<string, string> = {
    'src/sinter.types.ts': "export interface Kind { kind: 'a' | 'b'; v: number }\n",
    'src/components/x-ca.html': '<template data-sn-props="{ v: Kind }"><b data-sn-text="v.v"></b></template>\n',
    'src/components/x-cb.html': '<template data-sn-props="{ v: Kind }"><i data-sn-text="v.kind"></i></template>\n',
    // a candidate the branch around it rules out: SN538, a warning
    'index.html': `<!doctype html><html><head><title>x</title></head><body><sn-resource name="ks" src="/api/ks" type="Kind[]"></sn-resource>
<ul><template data-sn-for="k in ks"><li><template data-sn-if="k.kind === 'a'"><sn-component use="{ a: 'x-ca', b: 'x-cb' }[k.kind]" data-sn-with="{ v: k }"></sn-component></template></li></template></ul>${extra}</body></html>`,
  };
  for (const [f, s] of Object.entries(files)) { mkdirSync(join(root, f, '..'), { recursive: true }); writeFileSync(join(root, f), s); }
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  let error: string | null = null, warned: string[] = [];
  try {
    await build({ root, logLevel: 'silent', plugins: [sinter({ typecheck: true, ...(strict ? { strict: true } : {}) })], resolve: { alias }, build: { outDir: join(root, 'dist'), emptyOutDir: true } });
  } catch (e) { error = String((e as Error).message); } finally { warned = warn.mock.calls.map((c) => String(c[0])); warn.mockRestore(); }
  return { error, warned };
}

test('type errors and a warning: the build fails, its line counting each apart', async () => {
  const r = await run('<p data-sn-text="ks.length.nope"></p>');
  expect(r.error).toMatch(/sinter check: 1 type error\(s\), 1 warning\(s\)\n/);
  expect(r.error).toMatch(/SN208 type-error: Property 'nope' does not exist on type 'number'/);
  expect(r.error).toMatch(/warning SN538 unreachable-candidate/);
}, 120_000);

test('a warning alone: printed, and the build passes', async () => {
  const r = await run('');
  expect(r.error).toBe(null);
  expect(r.warned.filter((w) => w.includes('SN538'))).toEqual([expect.stringMatching(/warning SN538 unreachable-candidate: `x-cb` can never be chosen here/)]);
}, 120_000);

test('a warning alone under `strict`: an error, as the pages\' warnings are', async () => {
  const r = await run('', true);
  expect(r.error).toMatch(/sinter check: 1 type error\(s\), 0 warning\(s\)\n[\s\S]*SN538/);
}, 120_000);
