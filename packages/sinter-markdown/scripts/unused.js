// What scripts/build-parser.mjs puts in place of the markdown-it modules md.parse never runs: the renderer
// (md.parse reads tokens, it renders no HTML), the typographer's rules (`typographer` is off), linkify-it and
// markdown-it's linkify rules (`linkify` is off; scripts/autolink.js finds GFM's autolinks). markdown-it still
// constructs a renderer and a linkify-it at `new MarkdownIt()` and registers the rules, so this is a function: a rule
// that matches nothing, a constructor of an empty object.
export default function unused() {
  return false;
}
