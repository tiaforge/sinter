// What markdown-it imports from `entities`, over the table micromark uses (character-entities). The `entities`
// package's own tables are a packed trie that gzips to 21 kB; character-entities as an object to about 11.5 kB. The
// table here is that one packed by scripts/build-parser.mjs (`packed-entities`), about 7.3 kB: the names that share a
// value grouped, the groups sorted by code point, each its code point's distance from the one before in base 36
// (nothing for 1; `+` and the second code point, for the 93 that have two), `:` and its names joined by `,`, the
// groups joined by `;`. It is unpacked once, when the parser loads.
// markdown-it calls decodeHTML with one whole named reference, `&name;` (CommonMark requires the `;`); numeric
// references it decodes itself.
import PACKED from 'packed-entities';

function unpack(packed) {
  const table = new Map();
  let code = 0;
  for (const group of packed.split(';')) {
    const [cps, names] = group.split(':'), [delta, second] = cps.split('+');
    code += delta ? parseInt(delta, 36) : 1;
    const value = String.fromCodePoint(code) + (second ? String.fromCodePoint(parseInt(second, 36)) : '');
    for (const name of names.split(',')) table.set(name, value);
  }
  return table;
}
const ENTITIES = unpack(PACKED);

export function decodeHTML(match) {
  return (match[0] === '&' && match[match.length - 1] === ';' && ENTITIES.get(match.slice(1, -1))) || match;
}
