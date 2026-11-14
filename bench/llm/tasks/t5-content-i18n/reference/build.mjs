// Dependency-free reference for T5 (validates the grader), with a Markdown subset enough for content/.
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
const src = new URL('../workspace/content/', import.meta.url).pathname, SITE = 'https://fieldnotes.example', LANGS = ['en', 'de'];
const esc = (s) => s.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
const inline = (s) => esc(s).replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
const md = (t) => t.split(/\n{2,}/).map((b) => b.startsWith('```') ? `<pre><code>${esc(b.replace(/^```\w*\n|\n?```$/g, ''))}</code></pre>` : (b.match(/^(#{1,6}) (.*)/) ? `<h${RegExp.$1.length}>${inline(RegExp.$2)}</h${RegExp.$1.length}>` : `<p>${inline(b)}</p>`)).join('\n');
const L = { en: { locale: 'en-US', read: (n) => `${n} min read`, part: (n, t) => `Part ${n} of ${t}`, other: 'de' }, de: { locale: 'de-DE', read: (n) => `${n} Min. Lesezeit`, part: (n, t) => `Teil ${n} von ${t}`, other: 'en' } };
const posts = {};
for (const lang of LANGS) posts[lang] = readdirSync(src + lang).map((f) => {
  const [, fm, body] = readFileSync(`${src}${lang}/${f}`, 'utf8').match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  const m = Object.fromEntries(fm.split('\n').map((l) => [l.slice(0, l.indexOf(':')), l.slice(l.indexOf(':') + 1).trim()]));
  return { ...m, slug: f.slice(0, -3), part: m.part && +m.part, draft: m.draft === 'true', words: body.split(/\s+/).filter(Boolean).length, html: md(body.trim()) };
}).filter((p) => !p.draft).sort((a, b) => b.date.localeCompare(a.date));
const date = (lang, d) => new Date(d + 'T12:00:00Z').toLocaleDateString(L[lang].locale, { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' });
const time = (lang, d) => `<time datetime="${d}">${date(lang, d)}</time>`;
const postUrl = (lang, slug) => `/${lang}/posts/${slug}/`;
const page = (lang, title, body, { head = '', switchTo }) => `<!doctype html><html lang="${lang}"><meta charset="utf-8"><title>${esc(title)}</title>${head}<header><a href="/${lang}/">Field Notes</a> <a hreflang="${L[lang].other}" href="${switchTo}">${L[lang].other.toUpperCase()}</a></header><main>${body}</main></html>`;
rmSync('dist', { recursive: true, force: true });
const w = (path, s) => { mkdirSync(`dist${path}`, { recursive: true }); writeFileSync(`dist${path}${path.endsWith('/') ? 'index.html' : ''}`, s); };
const locs = [];
for (const lang of LANGS) {
  const ps = posts[lang], other = L[lang].other, pages = Math.ceil(ps.length / 2);
  for (let n = 1; n <= pages; n++) {
    const path = n === 1 ? `/${lang}/` : `/${lang}/page/${n}/`; locs.push(path);
    const nav = (n > 1 ? `<a rel="prev" href="${n === 2 ? `/${lang}/` : `/${lang}/page/${n - 1}/`}">‹</a>` : '') + (n < pages ? `<a rel="next" href="/${lang}/page/${n + 1}/">›</a>` : '');
    w(path, page(lang, 'Field Notes', ps.slice((n - 1) * 2, n * 2).map((p) => `<article data-testid="post"><a href="${postUrl(lang, p.slug)}">${esc(p.title)}</a> ${time(lang, p.date)}<p>${esc(p.description)}</p></article>`).join('') + nav, { switchTo: `/${other}/` }));
  }
  for (const p of ps) {
    const tr = posts[other].find((x) => x.slug === p.slug), path = postUrl(lang, p.slug); locs.push(path);
    const series = p.series ? ps.filter((x) => x.series === p.series).sort((a, b) => a.part - b.part) : [];
    const i = series.indexOf(p);
    const nav = p.series ? `<nav data-testid="series">${L[lang].part(p.part, series.length)} ${i > 0 ? `<a rel="prev" href="${postUrl(lang, series[i - 1].slug)}">‹</a>` : ''}${i < series.length - 1 ? `<a rel="next" href="${postUrl(lang, series[i + 1].slug)}">›</a>` : ''}</nav>` : '';
    const head = tr ? LANGS.map((l) => `<link rel="alternate" hreflang="${l}" href="${SITE}${postUrl(l, p.slug)}">`).join('') : '';
    w(path, page(lang, `${p.title} | Field Notes`, `<h1>${esc(p.title)}</h1>${time(lang, p.date)} <span data-testid="reading-time">${L[lang].read(Math.max(1, Math.ceil(p.words / 200)))}</span>${nav}${p.html}`, { head, switchTo: tr ? postUrl(other, p.slug) : `/${other}/` }));
  }
  writeFileSync(`dist/${lang}/rss.xml`, `<?xml version="1.0"?><rss version="2.0"><channel><title>Field Notes</title><link>${SITE}/${lang}/</link><description>Field Notes</description><language>${lang}</language>${ps.map((p) => `<item><title>${esc(p.title)}</title><link>${SITE}${postUrl(lang, p.slug)}</link><pubDate>${new Date(p.date).toUTCString()}</pubDate><description>${esc(p.description)}</description></item>`).join('')}</channel></rss>`);
}
w('/', '<!doctype html><html lang="en"><meta charset="utf-8"><title>Field Notes</title><meta http-equiv="refresh" content="0; url=/en/"><a href="/en/">Field Notes</a></html>');
writeFileSync('dist/sitemap.xml', `<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${locs.map((l) => `<url><loc>${SITE}${l}</loc></url>`).join('')}</urlset>`);
