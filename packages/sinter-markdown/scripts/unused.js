// What scripts/build-parser.mjs puts in place of the markdown-it rules md.parse never runs: the typographer's
// (`typographer` is off) and linkify's (`linkify` is off; scripts/autolink.js finds GFM's autolinks). markdown-it's
// parsers still register them, so this is a function: a rule that matches nothing.
export default function unused() {
  return false;
}
