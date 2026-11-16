// What markdown-it imports from `entities`, over the table micromark uses (character-entities): the
// `entities` package's own tables are a packed trie that gzips to 21 kB, this one to about 9 kB.
// markdown-it calls decodeHTML with one whole named reference, `&name;` (CommonMark requires the `;`);
// numeric references it decodes itself.
import { characterEntities } from 'character-entities';

const own = {}.hasOwnProperty;
export function decodeHTML(match) {
  const name = match.slice(1, -1);
  return match[0] === '&' && match[match.length - 1] === ';' && own.call(characterEntities, name) ? characterEntities[name] : match;
}
