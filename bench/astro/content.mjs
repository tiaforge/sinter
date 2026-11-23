// The posts both sites build (README.md): `n` markdown posts of six sections, each a heading, two paragraphs with
// inline marks and links, a list, a quote, a code block and a table. About 1,300 words and 420 nodes a post.
const words = 'sinter pages build data markdown list entry static runtime module html layout component slot resource field type check link folder content'.split(' ');
const sentence = (i, j) => Array.from({ length: 12 }, (_, k) => words[(i * 7 + j * 3 + k * 5) % words.length]).join(' ') + '.';
const para = (i, j) => Array.from({ length: 4 }, (_, k) => sentence(i, j * 5 + k)).join(' ');

const section = (i, s, n) => `## Section ${s + 1} of post ${i}

${para(i, s * 3)} See [the next post](/blog/post-${(i + 1) % n}/) and *emphasis* with \`code\`.

${para(i, s * 3 + 1)} **Strong words** and [a link](https://example.com/${i}/${s}).

- ${sentence(i, s + 20)}
- ${sentence(i, s + 21)} [a link](https://example.com/${i})
- ${sentence(i, s + 22)}

> ${sentence(i, s + 30)}

\`\`\`js
console.log(${i}, ${s});
\`\`\`

| Name | Value | Note |
| --- | ---: | --- |
| ${words[(i + s) % words.length]} | ${i * 10 + s} | ${sentence(i, s + 40)} |
| ${words[(i + s + 1) % words.length]} | ${i * 10 + s + 1} | *${words[(i + s + 2) % words.length]}* |
| ${words[(i + s + 3) % words.length]} | ${i * 10 + s + 2} | \`${words[(i + s + 4) % words.length]}\` |
`;

export const post = (i, n) => Array.from({ length: 6 }, (_, s) => section(i, s, n)).join('\n');
export const title = (i) => `Post ${i}`;
