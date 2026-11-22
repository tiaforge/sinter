// The tree of md.parse as elements, created directly (<md-view>'s script, components/internal/md-view.ts).
//
// It writes what the components write, element for element: the same tags, the same attributes (a URL attribute
// only with an allowed scheme: sinter's attrAllowed, as data-sn-attr checks it), text as text nodes. No markup is
// parsed. A change to a component's markup is a change here too: test/view.test.ts compares the two.
import { attrAllowed } from '@tiaforge-ui/sinter';
import type { Block, Inline, ListItem, Root, Table } from './sinter.types.js';

const WRAP: Record<string, string> = { emphasis: 'em', strong: 'strong', delete: 'del', kbd: 'kbd', sub: 'sub', sup: 'sup', mark: 'mark' };

const el = (tag: string) => document.createElement(tag);
/** an attribute as data-sn-attr writes it: none for null, undefined and false, '' for true */
function attr(e: Element, name: string, v: unknown): void {
  if (v == null || v === false) return;
  const s = v === true ? '' : '' + v;
  if (attrAllowed(e, name, s)) e.setAttribute(name, s);
}
/** phrasing content into `into`: text as text nodes, the rest by type */
function inline(list: readonly Inline[], into: Node): void {
  for (const n of list) {
    if (n.type === 'text') { into.appendChild(document.createTextNode(n.value)); continue; }
    let e: HTMLElement;
    const w = WRAP[n.type];
    if (w) { e = el(w); inline((n as { children: Inline[] }).children, e); }
    else if (n.type === 'inlineCode') { e = el('code'); e.textContent = n.value; }
    else if (n.type === 'break') e = el('br');
    else if (n.type === 'link') { e = el('a'); attr(e, 'href', n.url); attr(e, 'title', n.title); inline(n.children, e); }
    else if (n.type === 'image') { e = el('img'); attr(e, 'src', n.url); attr(e, 'alt', n.alt); attr(e, 'title', n.title); }
    else continue;
    into.appendChild(e);
  }
}
function item(n: ListItem, tight: boolean): HTMLElement {
  const li = el('li');
  if (n.checked !== null) {
    li.className = 'task-list-item';
    const c = el('input'); c.setAttribute('type', 'checkbox'); c.setAttribute('disabled', ''); attr(c, 'checked', n.checked);
    li.appendChild(c);
  }
  for (const b of n.children) {
    if (tight && b.type === 'paragraph') inline(b.children, li);
    else block(b, li);
  }
  return li;
}
function table(n: Table): HTMLElement {
  const box = el('div'), t = el('table'), head = el('thead');
  box.className = 'md-table';
  const row = (r: Table['children'][number], cell: string) => {
    const tr = el('tr');
    r.children.forEach((c, k) => { const d = el(cell); attr(d, 'align', n.align[k]); inline(c.children, d); tr.appendChild(d); });
    return tr;
  };
  for (const r of n.children.slice(0, 1)) head.appendChild(row(r, 'th'));
  t.appendChild(head);
  if (n.children.length > 1) { const body = el('tbody'); for (const r of n.children.slice(1)) body.appendChild(row(r, 'td')); t.appendChild(body); }
  box.appendChild(t);
  return box;
}
/** block content into `into`, by type */
function block(n: Block, into: Node): void {
  let e: HTMLElement;
  switch (n.type) {
    case 'paragraph': e = el('p'); inline(n.children, e); break;
    case 'heading': e = el(n.depth >= 1 && n.depth <= 5 ? 'h' + n.depth : 'h6'); attr(e, 'id', 'md-' + n.slug); inline(n.children, e); break;
    case 'thematicBreak': e = el('hr'); break;
    case 'blockquote': e = el('blockquote'); for (const b of n.children) block(b, e); break;
    case 'list': {
      e = el(n.ordered ? 'ol' : 'ul');
      if (n.ordered) attr(e, 'start', n.start === 1 ? null : n.start);
      for (const i of n.children) e.appendChild(item(i, !n.spread));
      break;
    }
    case 'code': { e = el('pre'); const c = el('code'); attr(c, 'class', n.lang ? 'language-' + n.lang : null); c.textContent = n.value; e.appendChild(c); break; }
    case 'table': e = table(n); break;
    case 'details': {
      e = el('details'); attr(e, 'open', n.open);
      if (n.summary.length) { const s = el('summary'); inline(n.summary, s); e.appendChild(s); }
      for (const b of n.children) block(b, e);
      break;
    }
    default: return;
  }
  into.appendChild(e);
}

/** the blocks of `doc` as a fragment */
export function build(doc: Root): DocumentFragment {
  const f = document.createDocumentFragment();
  for (const b of doc.children) block(b, f);
  return f;
}
