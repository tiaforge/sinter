// markdown-it imports punycode only for normalizeLink and normalizeLinkText, which parser-entry.js
// replaces: mdast keeps a destination as written.
export default { toASCII: (s) => s, toUnicode: (s) => s };
