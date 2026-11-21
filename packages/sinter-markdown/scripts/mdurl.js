// What markdown-it's utils import from `mdurl`: only markdown-it's default normalizeLink and normalizeLinkText use
// it, and parser-entry.js has its own (the tree keeps a destination as written). Calling one is a bug here.
const unused = () => { throw new Error('mdurl is not bundled into sinter/parser.js'); };
export const decode = unused, encode = unused, parse = unused, format = unused;
