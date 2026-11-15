// The spike's API data: a long article and a comment list, generated deterministically.
// Every node type the components render appears; `blocks` sets the article's length.
const words = 'sinter binds json apis to plain html with keyed resources and optimistic mutations compiled at build time so the page renders in the first frame'.split(' ');
let seed = 1;
const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
const pick = (a) => a[Math.floor(rnd() * a.length)];
const sentence = (n = 8 + Math.floor(rnd() * 10)) => {
  const w = Array.from({ length: n }, () => pick(words));
  // phrasing content: emphasis, strong, code, links, strikethrough, an entity
  const at = Math.floor(rnd() * n);
  const kind = Math.floor(rnd() * 6);
  if (kind === 0) w[at] = `*${w[at]}*`;
  if (kind === 1) w[at] = `**${w[at]} ${pick(words)}**`;
  if (kind === 2) w[at] = `\`${w[at]}()\``;
  if (kind === 3) w[at] = `[${w[at]}](/docs/${w[at]})`;
  if (kind === 4) w[at] = `~~${w[at]}~~`;
  if (kind === 5) w[at] = `${w[at]} &amp; ${pick(words)}`;
  const s = w.join(' ');
  return s[0].toUpperCase() + s.slice(1) + '.';
};
const para = () => Array.from({ length: 2 + Math.floor(rnd() * 3) }, () => sentence()).join(' ');

export function article(blocks = 300) {
  seed = 1;
  const out = ['# A long article', '', para(), ''];
  for (let i = 0; i < blocks; i++) {
    const k = i % 12;
    if (k === 0) out.push(`## Section ${i / 12 + 1}`, '');
    else if (k === 3) out.push(`### Part ${i}`, '');
    else if (k === 4) out.push(...Array.from({ length: 4 }, () => `- ${sentence(6)}`), '');
    else if (k === 6) out.push('```js', `const x${i} = render(${i});`, 'console.log(x' + i + ');', '```', '');
    else if (k === 7) out.push(`> ${sentence()}`, `> ${sentence()}`, '');
    else if (k === 8) out.push(...Array.from({ length: 3 }, (_, j) => `${j + 1}. ${sentence(5)}`), '');
    else if (k === 9 && i % 36 === 9) out.push('| name | value | note |', '| :--- | ---: | :---: |', ...Array.from({ length: 4 }, (_, j) => `| row ${j} | ${j * 7} | ${sentence(3)} |`), '');
    else if (k === 10 && i % 24 === 10) out.push(`![figure ${i}](/img/figure-${i}.png "Figure ${i}")`, '', '- [x] done', '- [ ] to do', '', '---', '');
    else if (k === 11 && i % 48 === 11) out.push('<div class="raw">raw <b>html</b></div>', '', `A line with a hard break  \nand <kbd>Ctrl</kbd> inline html.`, '');
    else out.push(para(), '');
  }
  return out.join('\n');
}

export function comments(n = 50) {
  seed = 7;
  return Array.from({ length: n }, (_, i) => ({
    id: i + 1,
    author: `user${i % 9}`,
    // user content: a heading, an image and raw HTML, which the parse options take out
    body: i % 10 === 0
      ? `# Not a heading\n\n${sentence()} ![img](/x.png) <script>alert(1)</script>`
      : `${sentence()} ${sentence()}${i % 3 === 0 ? `\n\n- ${sentence(4)}\n- ${sentence(4)}` : ''}`,
  }));
}
