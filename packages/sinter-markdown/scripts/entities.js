// What markdown-it imports from `entities`, over the table micromark uses (character-entities). The `entities`
// package's own tables are a packed trie that gzips to 21 kB; character-entities as an object to about 11.5 kB. The
// table here is that one packed by scripts/build-parser.mjs (`packed-entities`), about 7.5 kB: the entries sorted by
// code point, each its code point's distance from the one before, in base 36 (`+` and the second code point, for
// the 93 that have two), then its name, all separated by spaces. It is unpacked once, when the parser loads.
// markdown-it calls decodeHTML with one whole named reference, `&name;` (CommonMark requires the `;`); numeric
// references it decodes itself.
import PACKED from 'packed-entities';

function unpack(packed) {
  const table = new Map(), fields = packed.split(' ');
  let code = 0;
  for (let i = 0; i < fields.length; i += 2) {
    const [delta, second] = fields[i].split('+');
    code += parseInt(delta, 36);
    table.set(fields[i + 1], String.fromCodePoint(code) + (second ? String.fromCodePoint(parseInt(second, 36)) : ''));
  }
  return table;
}
const ENTITIES = unpack(PACKED);

export function decodeHTML(match) {
  return (match[0] === '&' && match[match.length - 1] === ';' && ENTITIES.get(match.slice(1, -1))) || match;
}
