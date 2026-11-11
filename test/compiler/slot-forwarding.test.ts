// Slot forwarding (docs/proposals/layouts.md, Slots in the head): a `<slot>` that is itself slot
// content of a component's tag passes what fills it on into that component's slot, in its first
// caller's scope.
import { describe, expect, test } from 'vitest';
import { compile } from '../../src/compiler/index.js';

function run(page: string, files: Record<string, string>) {
  const all: Record<string, string> = {};
  for (const [k, v] of Object.entries(files)) all[`/p/src/${k}`] = v;
  return compile(page, { file: '/p/index.html', root: '/p', dev: false, helpers: { module: null, names: [], namespaces: {} }, readFile: (p) => { if (p in all) return all[p]!; throw new Error('missing'); } });
}
const errors = (out: ReturnType<typeof run>) => out.diagnostics.filter((d) => d.severity === 'error').map((d) => `${d.code} ${d.message}`);

const SEO = '<template data-sn-head="{ title?: string }"><title data-sn-text="title ?? \'Blog\'">Blog</title><slot name="extra"><meta name="x" content="seo-fallback"></slot></template>';
const LAYOUT = `<!doctype html><html data-sn-layout="{ title?: string }"><head>
<seo-tags data-sn-prop="{ title }"><slot name="seo" slot="extra"></slot></seo-tags>
</head><body><x-card><slot name="aside" slot="side"><em>layout fallback</em></slot></x-card><main><slot></slot></main></body></html>`;
const CARD = '<template data-sn-component=""><section><div class="side"><slot name="side">card fallback</slot></div><slot></slot></section></template>';
const files = { 'layouts/site-layout.html': LAYOUT, 'components/seo-tags.html': SEO, 'components/x-card.html': CARD };

describe('slot forwarding', () => {
  test('a layout\'s head slot forwarded into a head component\'s slot', () => {
    const out = run('<site-layout><meta slot="seo" property="og:type" content="article"><meta slot="seo" name="robots" content="noindex"><p>x</p></site-layout>', files);
    expect(errors(out)).toEqual([]);
    const head = /<head>([\s\S]*)<\/head>/.exec(out.html)![1]!;
    expect(head).toMatch(/<title data-sn="\d+">Blog<\/title><meta property="og:type" content="article"><meta name="robots" content="noindex">/);
    expect(head).not.toContain('seo-fallback');
    expect(out.html).not.toMatch(/ slot=/);
  });

  test('left empty: the forwarding slot\'s fallback, or else the inner slot\'s', () => {
    const out = run('<site-layout><p>x</p></site-layout>', files);
    expect(out.html).toContain('<meta name="x" content="seo-fallback">');
    expect(out.html).toContain('<div class="side"><em>layout fallback</em></div>');
  });

  test('a body slot forwarded into a component, the content in the page\'s scope', () => {
    const out = run('<site-layout data-sn-state="{ n: 1 }"><b slot="aside" data-sn-text="n"></b><p>x</p></site-layout>', files);
    expect(errors(out)).toEqual([]);
    expect(out.html).toMatch(/<div class="side"><b data-sn="\d+"><\/b><\/div>/);
    expect(out.module).toContain('($) => ($.$s0.n)');
  });

  test('a component\'s own slot forwarded into a component it uses', () => {
    const outer = '<template data-sn-component=""><div class="outer"><x-card><slot name="head" slot="side"></slot></x-card></div></template>';
    const out = run('<div data-sn-state="{ k: 2 }"><x-outer><i slot="head" data-sn-text="k"></i></x-outer></div>', { 'components/x-card.html': CARD, 'components/x-outer.html': outer });
    expect(errors(out)).toEqual([]);
    expect(out.html).toMatch(/<div class="side"><i data-sn="\d+"><\/i><\/div>/);
    expect(out.module).toContain('($) => ($.$s0.k)');
  });
});
