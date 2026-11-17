// GFM autolink literals, as github.com (cmark-gfm) finds them: `www.`, `http(s)://` and `ftp://` URLs, emails, and
// `mailto:` and `xmpp:` emails, in text outside links. A core rule, run after markdown-it's own (parser-entry.js), in
// place of markdown-it's linkify, whose linkify-it and Unicode tables were about 5.7 kB gzip of the parser and links
// what GFM does not (`example.com`, `config.md`).
//
// Only these schemes come out, so no link this rule makes can be `javascript:`. Linear in the text: every match moves
// the scan forward, a run of email characters without an `@` is passed over whole, and the end of a link is trimmed
// by an index, its parentheses counted once (test/parse.test.ts, "autolinks stay linear").

/** a domain character: not whitespace, not ASCII punctuation other than `-` and `_` (non-ASCII is a domain's) */
const D = '[^\\s!-,./:-@[-^`{-~]';
/** at each position, in order: a scheme or `www.`, `mailto:` or `xmpp:` before an email, a run of email characters */
const SCAN = /(?:https?:\/\/|ftp:\/\/|www\.)|(?:mailto|xmpp):(?=[\w.+-]+@)|[\w.+-]+@?/gi;
const DOMAIN = new RegExp(`${D}+(?:\\.${D}+)*`, 'uy');
const PATH = /[^\s<]*/y, EMAIL = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/y, XMPP = /\/[\w@.-]*/y, ENTITY = /^&[a-z\d]+;$/i;
/** what ends a URL but is not its own */
const TRAILING = '?!.,:*_~\'"';

function exec(re, s, i) {
  re.lastIndex = i;
  return re.exec(s)?.[0] ?? null;
}

/** the end of the link at `i` in `s` and its href, or null; `start` is what SCAN matched at `i` */
function linkAt(s, i, start) {
  if (start.endsWith('@') || start.endsWith(':')) {
    // an email, after `mailto:` or `xmpp:` or none: a `.` after it is not its own, and it ends in no `-` or `_`
    const scheme = start.endsWith(':') ? start : '', j = i + scheme.length;
    let email = exec(EMAIL, s, j);
    if (!email) return null;
    if (email.endsWith('.')) email = email.slice(0, -1);
    if (/[-_]$/.test(email)) return null;
    let end = j + email.length;
    if (/^xmpp/i.test(scheme)) { const r = exec(XMPP, s, end); if (r) end += r.replace(/\.$/, '').length; }
    return [end, (scheme || 'mailto:') + s.slice(j, end)];
  }
  // a URL: a valid domain (no `_` in its last two segments; `www.` and at least one more period), then up to a
  // space or `<`
  const www = /^www/i.test(start), host = i + (www ? 0 : start.length);
  const domain = exec(DOMAIN, s, host);
  if (!domain) return null;
  const segments = domain.split('.');
  if (/_/.test(segments.slice(-2).join('')) || (www && segments.length < 3)) return null;
  const from = host + domain.length;
  let end = from + exec(PATH, s, from).length, open = 0, close = 0;
  for (let k = i; k < end; k++) if (s[k] === '(') open++; else if (s[k] === ')') close++;
  // what ends it and is not its own: trailing punctuation, a `)` with no `(`, an entity-like `&name;`
  while (end > from) {
    const c = s[end - 1];
    if (TRAILING.includes(c)) end--;
    else if (c === ')' && close > open) { close--; end--; }
    else if (c === ';') {
      const amp = s.lastIndexOf('&', end - 1);
      if (amp >= from && ENTITY.test(s.slice(amp, end))) end = amp; else break;
    } else break;
  }
  return [end, www ? 'http://' + s.slice(i, end) : s.slice(i, end)];
}

/** the core rule: splits each text token outside a link at the autolinks in it */
export function autolink(state) {
  for (const block of state.tokens) {
    if (block.type !== 'inline') continue;
    const out = [];
    let inLink = 0;
    for (const t of block.children) {
      if (t.type === 'link_open') inLink++;
      else if (t.type === 'link_close') inLink--;
      else if (t.type === 'html_inline') { if (/^<a[\s>]/i.test(t.content)) inLink++; else if (/^<\/a\s*>/i.test(t.content)) inLink--; }
      if (t.type !== 'text' || inLink > 0) { out.push(t); continue; }
      const s = t.content;
      let pos = 0, m;
      SCAN.lastIndex = 0;
      while ((m = SCAN.exec(s))) {
        const i = m.index, start = m[0], prev = i ? s[i - 1] : ' ';
        const email = start.endsWith('@') || start.endsWith(':');
        if (!email && !/^(?:https?:|ftp:|www\.)/i.test(start)) continue;   // a run with no `@`: passed over
        // `www.` after whitespace or `*`, `_`, `~`, `(`; a scheme after no letter or digit; an email after none of
        // its own characters
        const ok = /^www/i.test(start) ? /[\s*_~(]/.test(prev) : email ? !/[\w.+-]/.test(prev) : !/[a-z\d]/i.test(prev);
        const r = ok && linkAt(s, i, start);
        if (!r) { if (!start.endsWith('@')) SCAN.lastIndex = i + 1; continue; }
        // the tokens markdown-it's own linkify writes
        if (i > pos) out.push(token(state, 'text', '', 0, t.level, s.slice(pos, i)));
        const open = token(state, 'link_open', 'a', 1, t.level, '');
        open.attrs = [['href', state.md.normalizeLink(r[1])]];
        out.push(open, token(state, 'text', '', 0, t.level + 1, s.slice(i, r[0])), token(state, 'link_close', 'a', -1, t.level, ''));
        pos = SCAN.lastIndex = r[0];
      }
      if (pos === 0) out.push(t);
      else if (pos < s.length) out.push(token(state, 'text', '', 0, t.level, s.slice(pos)));
    }
    block.children = out;
  }
}

function token(state, type, tag, nesting, level, content) {
  const t = new state.Token(type, tag, nesting);
  t.level = level;
  t.content = content;
  if (tag === 'a') { t.markup = 'linkify'; t.info = 'auto'; }
  return t;
}
