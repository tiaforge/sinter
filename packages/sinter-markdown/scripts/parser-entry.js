// The source of sinter/parser.js: mdast-util-from-markdown with CommonMark and four GFM extensions
// (tables, task lists, strikethrough, autolinks). Footnotes are left out: the components render
// none. scripts/build-parser.mjs bundles this file into one module.
import { fromMarkdown } from 'mdast-util-from-markdown';
import { gfmAutolinkLiteral } from 'micromark-extension-gfm-autolink-literal';
import { gfmStrikethrough } from 'micromark-extension-gfm-strikethrough';
import { gfmTable } from 'micromark-extension-gfm-table';
import { gfmTaskListItem } from 'micromark-extension-gfm-task-list-item';
import { gfmAutolinkLiteralFromMarkdown } from 'mdast-util-gfm-autolink-literal';
import { gfmStrikethroughFromMarkdown } from 'mdast-util-gfm-strikethrough';
import { gfmTableFromMarkdown } from 'mdast-util-gfm-table';
import { gfmTaskListItemFromMarkdown } from 'mdast-util-gfm-task-list-item';

const options = {
  extensions: [gfmAutolinkLiteral(), gfmStrikethrough({ singleTilde: true }), gfmTable(), gfmTaskListItem()],
  mdastExtensions: [gfmAutolinkLiteralFromMarkdown(), gfmStrikethroughFromMarkdown(), gfmTableFromMarkdown(), gfmTaskListItemFromMarkdown()],
};

/** The mdast tree of `source`, as mdast-util-from-markdown returns it (with positions). */
export function tokenize(source) {
  return fromMarkdown(source, options);
}
