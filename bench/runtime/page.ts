// Mounts a page for the runtime benchmarks: the real compiler, a production build (no dev
// feature, no freezing), the document's own environment. Like `render()` from the testing
// module, minus its fake clock and dev checks, which would distort the timings.
import { compileParts } from '../../src/compiler/compile.js';
import { compactIR } from '../../src/ir.js';
import { mount, type App } from '../../src/runtime/app.js';
import { $k } from '../../src/runtime/security.js';
import * as builtins from '../../src/runtime/helpers.js';
import form from '../../src/form.js';
import select from '../../src/select.js';

/** features that are only parts of the renderer, split off the core for size: what the page would load */
const FEATURES: Record<string, typeof select> = { form, select };

const none = { module: null, names: [], namespaces: {} };
let current: App | null = null;

export function page(html: string): App {
  current?.destroy();
  const parts = compileParts(html, {
    file: '/bench/page.html', root: '/bench', dev: false, helpers: none, actions: { ...none, module: 'actions' },
    moduleSrc: 'about:blank', readFile: () => { throw new Error('no partials in benchmarks'); },
  });
  const errors = parts.diagnostics.filter((d) => d.severity === 'error');
  if (errors.length) throw new Error(errors.map((d) => d.message).join('\n'));
  const other = parts.features.filter((f) => !FEATURES[f]);
  if (other.length) throw new Error(`benchmark page needs features: ${other.join(', ')}`);
  const names = ['$k', ...parts.helpers.builtin];
  const values = [$k, ...parts.helpers.builtin.map((h) => (builtins as Record<string, unknown>)[h])];
  // eslint-disable-next-line no-new-func -- benchmarks only; pages load a compiled module
  const fns = new Function(...names, `"use strict"; return [\n${parts.fns.join(',\n')}\n];`)(...values);
  const inner = /<html[^>]*>([\s\S]*)<\/html>/i.exec(parts.html)?.[1] ?? parts.html;
  document.documentElement.innerHTML = inner.replace(/<script type="module" src="about:blank"><\/script>/, '');
  current = mount(document, { ir: compactIR(parts.ir), fns, request: [], features: parts.features.map((f) => FEATURES[f]!) });
  return current;
}

/** `n` items `{ id, name, score }` with names in random order. */
export function items(n: number, seed = 1) {
  let s = seed;
  const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647);
  return Array.from({ length: n }, (_, i) => ({ id: i, name: `item ${Math.floor(rnd() * 1e9)}`, score: i % 100 }));
}

export interface Case { name: string; setup?: () => void; run: () => void; runs?: number }

/** Runs each case for about `ms` (at least 10 and at most `runs` times after warmup) and prints a table of medians. */
export function measure(title: string, cases: Case[], ms = 400): void {
  const rows: string[] = [];
  for (const c of cases) {
    c.setup?.();
    // warm up for at least 5 runs and 150 ms (or the case's cap), so the JIT has settled
    const warm = performance.now() + 150;
    for (let i = 0; (i < 5 || performance.now() < warm) && i < (c.runs ?? Infinity) / 4; i++) c.run();
    c.setup?.();
    const t: number[] = [];
    const end = performance.now() + ms, max = c.runs ?? Infinity;
    while ((t.length < 10 || performance.now() < end) && t.length < max) {
      const a = performance.now();
      c.run();
      t.push(performance.now() - a);
    }
    t.sort((x, y) => x - y);
    const at = (q: number) => t[Math.min(t.length - 1, Math.floor(q * t.length))]!;
    rows.push(`| ${c.name} | ${at(0.5).toFixed(3)} | ${at(0.9).toFixed(3)} | ${t.length} |`);
  }
  console.log(`\n${title}\n\n| case | median ms | p90 ms | runs |\n| --- | ---: | ---: | ---: |\n${rows.join('\n')}`);
}
