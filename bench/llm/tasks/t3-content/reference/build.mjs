// Dependency-free reference for T3 (validates the grader), with a Markdown subset enough for content/.
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
const src = process.env.CONTENT ?? new URL('../workspace/content/', import.meta.url).pathname;
const esc = (s) => s.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
const inline = (s) => esc(s).replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>').replace(/\[(.+?)\]\((.+?)\)/g, '<a href="$2">$1</a>');
const md = (t) => t.split(/\n{2,}/).map((b) => {
  if (b.startsWith('```')) return `<pre><code>${esc(b.replace(/^```\w*\n|\n?```$/g, ''))}</code></pre>`;
  const h = b.match(/^(#{1,6}) (.*)/); if (h) return `<h${h[1].length}>${inline(h[2])}</h${h[1].length}>`;
  return `<p>${inline(b)}</p>`;
}).join('\n');
const posts = readdirSync(src).filter((f) => f.endsWith('.md')).map((f) => {
  const [, fm, body] = readFileSync(src + f, 'utf8').match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  const meta = Object.fromEntries(fm.split('\n').map((l) => [l.slice(0, l.indexOf(':')), l.slice(l.indexOf(':') + 1).trim()]));
  return { slug: f.slice(0, -3), title: meta.title, date: meta.date, description: meta.description, draft: meta.draft === 'true',
    tags: meta.tags.replace(/[[\]]/g, '').split(',').map((s) => s.trim()), html: md(body.trim()) };
}).filter((p) => !p.draft).sort((a, b) => b.date.localeCompare(a.date));
const page = (title, body, desc = '') => `<!doctype html><html lang="en"><meta charset="utf-8"><title>${esc(title)}</title>${desc && `<meta name="description" content="${esc(desc)}">`}<header><a href="/">Field Notes</a></header><main>${body}</main></html>`;
const card = (p) => `<article data-testid="post"><a href="/posts/${p.slug}/">${esc(p.title)}</a> <time datetime="${p.date}">${p.date}</time><p>${esc(p.description)}</p></article>`;
rmSync('dist', { recursive: true, force: true });
const w = (path, s) => { mkdirSync(`dist${path}`, { recursive: true }); writeFileSync(`dist${path}index.html`, s); };
w('/', page('Field Notes', posts.map(card).join('')));
for (const p of posts) w(`/posts/${p.slug}/`, page(`${p.title} | Field Notes`, `<h1>${esc(p.title)}</h1><time datetime="${p.date}">${p.date}</time>${p.html}<p>${p.tags.map((t) => `<a href="/tags/${t}/">${t}</a>`).join(' ')}</p>`, p.description));
for (const t of new Set(posts.flatMap((p) => p.tags))) w(`/tags/${t}/`, page(`${t} | Field Notes`, `<h1>Tag: ${t}</h1>${posts.filter((p) => p.tags.includes(t)).map(card).join('')}`));
writeFileSync('dist/rss.xml', `<?xml version="1.0"?><rss version="2.0"><channel><title>Field Notes</title><link>https://fieldnotes.example/</link><description>Field Notes</description>${posts.map((p) => `<item><title>${esc(p.title)}</title><link>https://fieldnotes.example/posts/${p.slug}/</link><pubDate>${new Date(p.date).toUTCString()}</pubDate><description>${esc(p.description)}</description></item>`).join('')}</channel></rss>`);
