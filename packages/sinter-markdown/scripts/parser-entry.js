// The source of sinter/parser.js: markdown-it's parsers (CommonMark, GFM tables and `~~strikethrough~~`) with GFM's
// autolink literals (scripts/autolink.js), configured for md.parse. It returns markdown-it's tokens; md.parse (sinter/parse.ts)
// builds its tree from them in one pass, with GFM task lists. scripts/build-parser.mjs bundles this file into one
// module, leaving out what md.parse never runs (scripts/unused.js). markdown-it rather than micromark: on a 47.5 kB
// article it parses in 23 ms cold where micromark takes 160 ms, which was most of an API article's time to first render.
//
// The parsers are driven directly, not through `new MarkdownIt()`: its class brings the presets, the renderer, the
// plugin API and the default link normalizers (mdurl, punycode), none of which md.parse runs. `md` is what the rules
// read from `state.md`: the parsers, the link helpers, and the two options that differ from false (`typographer` and
// `linkify` are off, so their rules never read `quotes` or `md.linkify`).
import Core from 'markdown-it/lib/parser_core.mjs';
import ParserBlock from 'markdown-it/lib/parser_block.mjs';
import ParserInline from 'markdown-it/lib/parser_inline.mjs';
import * as helpers from 'markdown-it/lib/helpers/index.mjs';
import { unescapeAll } from 'markdown-it/lib/common/utils.mjs';
import { autolink } from './autolink.js';

const keep = (u) => u;
const md = {
  options: { html: true, maxNesting: 100 },
  core: new Core(), block: new ParserBlock(), inline: new ParserInline(), helpers,
  validateLink: () => true,           // md.parse and sinter's attribute writer decide what a URL may be
  normalizeLink: keep,                // a destination is kept as written, decoded
  normalizeLinkText: keep,
};
md.core.ruler.push('autolink', autolink);

/** The block tokens of `source`, each `inline` one with its `children`; a fence's `info` is unescaped (`f&ouml;\+o` is `fö+o`). */
export function tokenize(source) {
  const state = new md.core.State(source, md, {});
  md.core.process(state);
  for (const t of state.tokens) if (t.type === 'fence') t.info = unescapeAll(t.info);
  return state.tokens;
}
