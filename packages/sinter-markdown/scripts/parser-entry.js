// The source of sinter/parser.js: markdown-it (CommonMark, GFM tables and `~~strikethrough~~`, and autolinks
// through its linkify), with GFM task lists added here, and its tokens turned into the mdast
// mdast-util-from-markdown gives, for the parts md.parse reads. scripts/build-parser.mjs bundles this file
// into one module. markdown-it rather than micromark: on a 47.5 kB article it parses in 23 ms cold where
// micromark takes 160 ms, which was most of an API article's time to first render.
import MarkdownIt from 'markdown-it';

const md = new MarkdownIt({ html: true, linkify: true });
md.validateLink = () => true;           // md.parse and sinter's attribute writer decide what a URL may be
md.normalizeLink = (u) => u;            // mdast keeps a destination as written, decoded
md.normalizeLinkText = (u) => u;
const { unescapeAll } = md.utils;

// a GFM task list item: its first paragraph starts with `[ ]`, `[x]` or `[X]` and whitespace
const TASK = /^\[([ xX])\][ \t]+/;

export function tokenize(source) {
  const tokens = md.parse(source, {});
  const root = { type: 'root', children: [] };
  const stack = [root];
  const top = () => stack[stack.length - 1];
  const open = (node) => { top().children.push(node); stack.push(node); return node; };
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    switch (t.type) {
      case 'paragraph_open': {
        // markdown-it hides the paragraphs of a tight list's items: a visible one makes its list loose
        if (top().type === 'listItem' && !t.hidden) top().spread = true;
        open({ type: 'paragraph', children: [] });
        break;
      }
      case 'heading_open': open({ type: 'heading', depth: +t.tag.slice(1), children: [] }); break;
      case 'blockquote_open': open({ type: 'blockquote', children: [] }); break;
      case 'bullet_list_open': open({ type: 'list', ordered: false, start: null, spread: false, children: [] }); break;
      case 'ordered_list_open': { const s = t.attrGet('start'); open({ type: 'list', ordered: true, start: s == null ? 1 : +s, spread: false, children: [] }); break; }
      case 'list_item_open': open({ type: 'listItem', spread: false, checked: null, children: [] }); break;
      case 'table_open': open({ type: 'table', align: [], children: [] }); break;
      case 'tr_open': open({ type: 'tableRow', children: [] }); break;
      case 'th_open': case 'td_open': {
        const style = t.attrGet('style'); const a = style ? /text-align:(\w+)/.exec(style)[1] : null;
        if (t.type === 'th_open') stack.find((n) => n.type === 'table').align.push(a);
        open({ type: 'tableCell', children: [] }); break;
      }
      case 'paragraph_close': case 'heading_close': case 'blockquote_close': case 'bullet_list_close': case 'ordered_list_close':
      case 'table_close': case 'tr_close': case 'th_close': case 'td_close': stack.pop(); break;
      case 'list_item_close': {
        const item = stack.pop();
        const first = item.children[0];
        if (first?.type === 'paragraph' && first.children[0]?.type === 'text') {
          const m = TASK.exec(first.children[0].value);
          if (m) { item.checked = m[1] !== ' '; first.children[0].value = first.children[0].value.slice(m[0].length); if (!first.children[0].value) first.children.shift(); }
        }
        break;
      }
      case 'thead_open': case 'thead_close': case 'tbody_open': case 'tbody_close': break;
      case 'hr': top().children.push({ type: 'thematicBreak' }); break;
      case 'code_block': top().children.push({ type: 'code', lang: null, meta: null, value: t.content.replace(/\n$/, '') }); break;
      case 'fence': {
        const info = unescapeAll(t.info).trim(); const sp = info.search(/\s/);
        top().children.push({ type: 'code', lang: info ? (sp < 0 ? info : info.slice(0, sp)) : null, meta: sp < 0 ? null : info.slice(sp).trim() || null, value: t.content.replace(/\n$/, '') });
        break;
      }
      case 'html_block': top().children.push({ type: 'html', value: t.content.replace(/\n+$/, '') }); break;
      case 'inline': inline(t.children, top()); break;
      default: break;
    }
  }
  // a list is loose when any of its items is
  (function mark(n) { for (const c of n.children ?? []) mark(c); if (n.type === 'list') n.spread = n.children.some((i) => i.spread); })(root);
  return root;
}

function inline(tokens, parent) {
  const stack = [parent];
  const top = () => stack[stack.length - 1];
  const text = (value) => {
    const kids = top().children; const last = kids[kids.length - 1];
    if (last?.type === 'text') last.value += value; else kids.push({ type: 'text', value });
  };
  const open = (n) => { top().children.push(n); stack.push(n); };
  for (const t of tokens) {
    switch (t.type) {
      case 'text': case 'text_special': text(t.content); break;
      case 'softbreak': text('\n'); break;
      case 'hardbreak': top().children.push({ type: 'break' }); break;
      case 'em_open': open({ type: 'emphasis', children: [] }); break;
      case 'strong_open': open({ type: 'strong', children: [] }); break;
      case 's_open': open({ type: 'delete', children: [] }); break;
      case 'link_open': open({ type: 'link', url: t.attrGet('href') ?? '', title: t.attrGet('title') ?? null, children: [] }); break;
      case 'em_close': case 'strong_close': case 's_close': case 'link_close': stack.pop(); break;
      case 'code_inline': top().children.push({ type: 'inlineCode', value: t.content }); break;
      case 'html_inline': top().children.push({ type: 'html', value: t.content }); break;
      case 'image': top().children.push({ type: 'image', url: t.attrGet('src') ?? '', title: t.attrGet('title') ?? null, alt: plain(t.children) }); break;
      default: break;
    }
  }
}

/** an image's alt: the text of its description, without markup (as mdast's `alt`) */
function plain(tokens) {
  let s = '';
  for (const t of tokens ?? []) {
    if (t.type === 'text' || t.type === 'text_special' || t.type === 'code_inline') s += t.content;
    else if (t.type === 'softbreak') s += '\n';
    else if (t.type === 'image') s += plain(t.children);
  }
  return s;
}
