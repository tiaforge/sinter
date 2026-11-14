// `sinter docs [topic]`: one part of the docs that ship in the package (llms.txt, docs/diagnostics.md), so a
// coding agent can look up a section, an attribute or a diagnostic instead of reading all of llms.txt.

export interface Section { title: string; slug: string; level: number; text: string }

export const slugOf = (title: string) => title.toLowerCase().replace(/<[^>]*>|`/g, (m) => (m.startsWith('<') ? m.slice(1, -1) : '')).replace(/[^a-z0-9$]+/g, '-').replace(/^-|-$/g, '');

/** The `##` and `###` sections of a Markdown file; a `##` section's text includes its `###` children. */
export function sections(md: string): Section[] {
  const lines = md.split('\n');
  const heads: Array<{ i: number; level: number; title: string }> = [];
  let fence = false;
  lines.forEach((l, i) => {
    if (l.startsWith('```')) fence = !fence;
    const m = !fence && /^(#{2,3}) (.+)$/.exec(l);
    if (m) heads.push({ i, level: m[1]!.length, title: m[2]!.trim() });
  });
  return heads.map((h, k) => {
    const end = heads.slice(k + 1).find((n) => n.level <= h.level)?.i ?? lines.length;
    return { title: h.title, slug: slugOf(h.title), level: h.level, text: lines.slice(h.i, end).join('\n').trimEnd() };
  });
}

export interface Docs { llms: string; diagnostics: string }

/** What `sinter docs <topic>` prints, and whether it found something. */
export function lookup(docs: Docs, topic: string | undefined): { text: string; found: boolean } {
  const all = sections(docs.llms);
  if (!topic) {
    const toc = all.map((s) => `${s.level === 3 ? '    ' : '  '}${s.slug.padEnd(s.level === 3 ? 34 : 36)} ${s.title}`);
    return {
      found: true,
      text: ['sinter docs <topic>: one part of llms.txt. Topics:', '', ...toc, '',
        'Also: an attribute or element (`sinter docs data-sn-for`, `sinter docs sn-event`), a diagnostic (`sinter docs SN318`),',
        'or any words (`sinter docs optimistic rollback`): the lines that have all of them.'].join('\n'),
    };
  }
  const t = topic.trim();
  // a diagnostic: its section of docs/diagnostics.md
  const code = /^sn\d{3}$/i.test(t) ? t.toUpperCase() : null;
  if (code) {
    const s = sections(docs.diagnostics).find((x) => x.title.startsWith(`${code} `));
    return s ? { text: s.text, found: true } : { text: `sinter docs: no diagnostic ${code}`, found: false };
  }
  // a section, by its slug or its title's words
  const slug = slugOf(t);
  const exact = all.filter((s) => s.slug === slug);
  const pick = exact.length ? exact : all.filter((s) => s.slug.startsWith(slug) || (slug.length > 3 && s.slug.includes(slug)));
  if (pick.length === 1) return { text: pick[0]!.text, found: true };
  // an attribute or element: its reference line, then the other lines that name it
  const name = /^(data-sn-[\w-]+|sn-[\w-]+)$/.exec(t)?.[1];
  if (name) {
    const ref = docs.llms.split('\n').filter((l) => l.startsWith(name.startsWith('sn-') ? `- \`<${name}>\`` : `- \`${name}\``));
    if (ref.length) return { text: ref.join('\n') + seeAlso(all, name), found: true };
  }
  if (pick.length > 1) return { text: `sinter docs: \`${t}\` matches several sections:\n${pick.map((s) => `  ${s.slug}  ${s.title}`).join('\n')}`, found: true };
  // words: the lines that have all of them, under their section
  const words = t.toLowerCase().split(/\s+/).filter(Boolean);
  const hits: string[] = [];
  for (const s of all.filter((x) => x.level === 2)) {
    const own = s.text.split('\n').filter((l) => !/^#{2,3} /.test(l) && words.every((w) => l.toLowerCase().includes(w)));
    if (own.length) hits.push(`## ${s.title} (sinter docs ${s.slug})`, ...own.map((l) => (l.length > 600 ? l.slice(0, 600) + ' …' : l)), '');
  }
  return hits.length ? { text: hits.join('\n').trimEnd(), found: true } : { text: `sinter docs: nothing on \`${t}\`; \`sinter docs\` lists the topics`, found: false };
}

/** Sections other than the reference lists that name an attribute or element. */
function seeAlso(all: Section[], name: string): string {
  // a section's own text: a `##` section without its `###` children, which are listed on their own
  const own = (s: Section) => (s.level === 2 ? s.text.split('\n### ')[0]! : s.text);
  const other = all.filter((s) => !['attributes', 'elements'].includes(s.slug) && own(s).includes(name)).map((s) => s.slug);
  return other.length ? `\n\nAlso in: ${other.map((s) => `sinter docs ${s}`).join(', ')}` : '';
}
