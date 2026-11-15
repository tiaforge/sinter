// md.parse: markdown to an mdast tree (CommonMark + GFM), as an ordinary helper loaded with the page.
// The spike's stand-in for the library's parser (proposal section 11). Positions are dropped: the
// components never read them, and they would double the size of embedded data.
import { fromMarkdown } from 'mdast-util-from-markdown';
import { gfm } from 'micromark-extension-gfm';
import { gfmFromMarkdown } from 'mdast-util-gfm';

const strip = (n) => {
  delete n.position;
  if (n.children) for (const c of n.children) strip(c);
  return n;
};

/**
 * How often parse ran and for how long, for measure.mjs (re-parse per render). One entry per copy of
 * this module: the early file and the page module each bundle their own. Not part of the contract.
 */
const stats = { parses: 0, ms: 0, bytes: 0, early: typeof document !== 'undefined' && document.readyState === 'loading' };
if (typeof window !== 'undefined') (window.__mdStats ??= []).push(stats);

/**
 * The tree for `source`. Options (section 10), applied after parsing:
 * - `headings: 'strong'` turns headings into paragraphs of strong text;
 * - `images: 'link'` turns images into links to the image;
 * - `html: 'text' | 'drop'` (default 'text') shows raw HTML as written, or drops it.
 */
export function parse(source, options) {
  const t0 = performance.now();
  stats.parses++;
  stats.bytes += source?.length ?? 0;
  const tree = strip(fromMarkdown(source ?? '', { extensions: [gfm()], mdastExtensions: [gfmFromMarkdown()] }));
  if (options) policy(tree, options);
  stats.ms += performance.now() - t0;
  return tree;
}

function policy(n, o) {
  if (!n.children) return;
  n.children = n.children.flatMap((c) => {
    if (c.type === 'heading' && o.headings === 'strong') c = { type: 'paragraph', children: [{ type: 'strong', children: c.children }] };
    else if (c.type === 'image' && o.images === 'link') c = { type: 'link', url: c.url, children: [{ type: 'text', value: c.alt || c.url }] };
    else if (c.type === 'html') {
      if (o.html === 'drop') return [];
      c = { type: 'text', value: c.value };
    }
    policy(c, o);
    return [c];
  });
}

/** The key of a block node in the components' dispatch map: headings by depth, lists by kind. */
export const kind = (n) => (n.type === 'heading' ? 'h' + n.depth : n.type === 'list' ? (n.ordered ? 'ol' : 'ul') : n.type);
