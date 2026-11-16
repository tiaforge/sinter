// What the tests' API sends: an article and comments, with entities (`&amp;`) and user content.

/** the policy every browser test runs under: sinter's Trusted Types harness */
export const CSP = "script-src 'self'; style-src 'self'; require-trusted-types-for 'script'";

export const POST = {
  title: 'Fish &amp; chips',
  body: `# Fish &amp; chips

A short history of *fish &amp; chips*, with [a source](https://example.com/history) and \`code &amp; more\`.

## Where

- London &copy; 1860
- Lancashire

![A plate](/uploads/plate.png)

<kbd>Ctrl</kbd> is shown as written.
`,
};
export const COMMENTS = [
  { id: 1, author: 'Ada', body: 'Great post &amp; thanks!' },
  { id: 2, author: 'Grace', body: '# Not a heading\n\n![a photo](https://example.com/p.jpg) and [a link](https://example.com)' },
  { id: 3, author: 'Linus', body: '<script>alert(1)</script>\n\nA [bad link](javascript:alert(1)).' },
];
