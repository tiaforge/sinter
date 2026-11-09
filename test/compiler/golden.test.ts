import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, test } from 'vitest';
import { compileParts, pageModule } from '../../src/compiler/index.js';
import { compactIR, validateIR } from '../../src/ir.js';

const dir = resolve(__dirname, 'golden');
const files: Record<string, string> = {
  [`${dir}/partials/contact-dialog.html`]: readFileSync(resolve(__dirname, '../fixtures/partials/contact-dialog.html'), 'utf8'),
};

for (const name of readdirSync(dir).filter((f) => f.endsWith('.html'))) {
  test(`golden: ${name}`, async () => {
    const opts = {
      file: `${dir}/${name}`, root: dir, dev: false, moduleSrc: `/@sinter/${name}.js`,
      readFile: (p: string) => { if (!(p in files)) throw new Error('missing'); return files[p]!; },
      helpers: { module: null, names: [], namespaces: {} },
    };
    const parts = compileParts(readFileSync(`${dir}/${name}`, 'utf8'), opts);
    expect(parts.diagnostics).toEqual([]);
    expect(validateIR(parts.ir, parts.fns.length)).toEqual([]);
    // and as the page module carries it
    expect(validateIR(compactIR(parts.ir), parts.fns.length)).toEqual([]);
    await expect(parts.html).toMatchFileSnapshot(`golden/__out__/${name}`);
    await expect(pageModule(parts, opts)).toMatchFileSnapshot(`golden/__out__/${name}.js`);
  });
}
