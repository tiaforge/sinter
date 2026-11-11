import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, test } from 'vitest';
import { compileParts, pageModule } from '../../src/compiler/index.js';
import { compactIR, validateIR } from '../../src/ir.js';

const dir = resolve(__dirname, 'golden');
const files: Record<string, string> = {
  [`${dir}/src/components/article-card.html`]: `<template data-sn-component="{ article: { slug: string; title: string }; compact?: boolean }" data-sn-emits="{ select: string }">
  <article data-sn-class="{ compact }">
    <h2 data-sn-text="article.title" data-sn-on-click="emit('select', article.slug)"></h2>
    <slot name="meta"></slot>
    <ul><template data-sn-for="a in [1, 2]" data-sn-key="a"><li data-sn-text="article.slug + a"></li></template></ul>
  </article>
</template>`,
  [`${dir}/src/components/rating-input.html`]: `<template data-sn-component="{ value: string | null }" data-sn-emits="{ change: string }">
  <button data-sn-on-click="emit('change', 'x')" data-sn-text="value ?? '-'"></button>
</template>`,
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
