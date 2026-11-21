// The inlang message format's parser (docs/messages.md): a message file's messages in their compact form (./format.ts).
// Pure, with no file access, so the testing module and the build share it.
import type { Message, Part, Selector } from './format.js';

/** a pattern with `{name}` placeholders and `\{`, `\}`, `\\` escapes; a formatted placeholder (`{x: number}`) is refused */
export function parsePattern(text: string, where: string): Part[] {
  const out: Part[] = [];
  let lit = '';
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (c === '\\' && /[{}\\]/.test(text[i + 1] ?? '')) { lit += text[++i]; continue; }
    if (c === '{') {
      const end = text.indexOf('}', i);
      const inner = end < 0 ? '' : text.slice(i + 1, end).trim();
      // `{name}`, or a formatted one: `{rate: number style=percent}`, `{at: datetime dateStyle=long}`
      const m = /^([A-Za-z_$][\w$]*)(?:\s*:\s*(number|datetime)((?:\s+[A-Za-z]+=[\w-]+)*))?$/.exec(inner);
      if (!m) throw new Error(`${where}: \`{${inner}}\` is not a placeholder sinter reads (\`{count}\`, \`{rate: number style=percent}\`, \`{at: datetime dateStyle=long}\`); markup is not supported`);
      if (lit) out.push(lit);
      lit = '';
      const o = m[3] ? Object.fromEntries(m[3].trim().split(/\s+/).map((kv) => kv.split('=') as [string, string])) : null;
      out.push({ v: m[1]!, ...(m[2] ? { f: m[2] as 'number' | 'datetime' } : {}), ...(o ? { o } : {}) });
      i = end;
      continue;
    }
    lit += c;
  }
  if (lit || !out.length) out.push(lit);
  return out;
}

/**
 * A complex message (`[{ declarations, selectors, match }]`): its selectors through their declarations (`input x`,
 * `local y = x: plural`, with `type=ordinal`, or `local y = x`, an exact value) and its variants (`sel=key, …`).
 */
export function parseComplex(value: unknown, where: string): Message {
  const v = Array.isArray(value) && value.length === 1 ? value[0] as { declarations?: unknown; selectors?: unknown; match?: unknown } : null;
  if (!v || !Array.isArray(v.selectors) || !v.match || typeof v.match !== 'object') throw new Error(`${where}: a complex message is \`[{ declarations, selectors, match }]\``);
  const locals = new Map<string, Selector>();
  for (const d of Array.isArray(v.declarations) ? v.declarations : []) {
    const s = String(d).trim();
    if (/^input\s+[A-Za-z_$][\w$]*$/.test(s)) continue;
    const m = /^local\s+([A-Za-z_$][\w$]*)\s*=\s*([A-Za-z_$][\w$]*)(?:\s*:\s*(\w+)((?:\s+\w+=\w+)*))?\s*$/.exec(s);
    if (!m) throw new Error(`${where}: the declaration \`${s}\` is not one sinter reads (\`input x\`, \`local y = x: plural\`, \`local y = x\`)`);
    const [, name, input, fn, opts] = m as unknown as [string, string, string, string | undefined, string | undefined];
    if (fn && fn !== 'plural') throw new Error(`${where}: \`${fn}\` in \`${s}\` is not a function sinter reads (\`plural\`)`);
    locals.set(name, { n: input, f: fn ? (/\btype=ordinal\b/.test(opts ?? '') ? 'ordinal' : 'plural') : null });
  }
  const selectors = (v.selectors as unknown[]).map((x) => String(x));
  const s: Selector[] = selectors.map((x) => locals.get(x) ?? { n: x, f: null });
  const variants: Array<[string[], Part[]]> = [];
  for (const [k, text] of Object.entries(v.match as Record<string, unknown>)) {
    if (typeof text !== 'string') throw new Error(`${where}: the variant \`${k}\` is not text`);
    const byName = new Map(k.split(',').map((p) => { const [a, b] = p.split('=').map((x) => x.trim()); return [a!, b ?? ''] as const; }));
    variants.push([selectors.map((x) => byName.get(x) ?? '*'), parsePattern(text, `${where} (${k})`)]);
  }
  return { s, v: variants };
}

/** one message file's messages, nested objects flattened to dotted ids (`inbox.title`) */
export function flatten(json: Record<string, unknown>, where: string, prefix = '', out = new Map<string, Message>()): Map<string, Message> {
  for (const [k, v] of Object.entries(json)) {
    if (k === '$schema') continue;
    const id = prefix + k;
    if (typeof v === 'string') out.set(id, { p: parsePattern(v, `${where}: \`${id}\``) });
    else if (Array.isArray(v)) out.set(id, parseComplex(v, `${where}: \`${id}\``));
    else if (v && typeof v === 'object') flatten(v as Record<string, unknown>, where, `${id}.`, out);
    else throw new Error(`${where}: \`${id}\` is not a message`);
  }
  for (const id of out.keys()) if ([...out.keys()].some((o) => o.startsWith(`${id}.`))) throw new Error(`${where}: \`${id}\` is both a message and a group of messages`);
  return out;
}
