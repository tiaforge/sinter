// The source of sinter/parser.js: markdown-it (CommonMark, GFM tables and `~~strikethrough~~`) with GFM's autolink
// literals (scripts/autolink.js), configured for md.parse. It returns markdown-it's tokens; md.parse (sinter/parse.ts)
// builds its tree from them in one pass, with GFM task lists. scripts/build-parser.mjs bundles this file into one
// module, leaving out what md.parse never runs (scripts/unused.js). markdown-it rather than micromark: on a 47.5 kB
// article it parses in 23 ms cold where micromark takes 160 ms, which was most of an API article's time to first render.
import MarkdownIt from 'markdown-it';
import { autolink } from './autolink.js';

const md = new MarkdownIt({ html: true, linkify: false });
md.validateLink = () => true;           // md.parse and sinter's attribute writer decide what a URL may be
md.normalizeLink = (u) => u;            // a destination is kept as written, decoded
md.normalizeLinkText = (u) => u;
md.core.ruler.push('autolink', autolink);
const { unescapeAll } = md.utils;

/** The block tokens of `source`, each `inline` one with its `children`; a fence's `info` is unescaped (`f&ouml;\+o` is `fö+o`). */
export function tokenize(source) {
  const tokens = md.parse(source, {});
  for (const t of tokens) if (t.type === 'fence') t.info = unescapeAll(t.info);
  return tokens;
}
