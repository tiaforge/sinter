// What markdown-it imports from `mdurl`: only its default normalizeLink and normalizeLinkText use it, and
// parser-entry.js replaces both (the tree keeps a destination as written). Calling one is a bug here.
const unused = () => { throw new Error('mdurl is not bundled into sinter/parser.js'); };
export const decode = unused, encode = unused, parse = unused, format = unused;
