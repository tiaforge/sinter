// `operation="…"` on a resource, without TypeScript: completion of the OpenAPI operations it can
// name, and a hover with the URL the operation is called at.
import { parseExpressionAt } from 'acorn';
import type * as acorn from 'acorn';
import { findOperation, operationRef, operationUrl, operations, type OpenApiSpec, type Operation } from '../compiler/openapi.js';
import { elementAt } from './markup.js';

/** The `operation` attribute the offset is in: its element's `params`, and the value's range (quotes excluded). */
function operationAt(text: string, offset: number): { value: string; from: number; to: number; inValue: boolean; params: string | null } | null {
  const hit = elementAt(text, offset);
  if (!hit || hit.el.tagName !== 'sn-resource') return null;
  const a = hit.el.sourceCodeLocation?.attrs?.operation;
  if (!a || offset < a.startOffset || offset > a.endOffset) return null;
  const raw = text.slice(a.startOffset, a.endOffset);
  const q = raw.search(/["']/);
  const from = q < 0 ? a.endOffset : a.startOffset + q + 1;
  const close = q < 0 ? -1 : raw.slice(q + 1).search(/["']/);
  const to = q < 0 ? a.endOffset : close < 0 ? a.endOffset : from + close;
  const params = hit.el.attrs.find((x) => x.name === 'params')?.value ?? null;
  return { value: text.slice(from, to), from, to, inValue: q >= 0 && offset >= from && offset <= to, params };
}

/** Completion items for an `operation="…"` value: the GET operations of the specs. */
export function operationCompletions(text: string, offset: number, specs: OpenApiSpec[]):
  Array<{ label: string; detail: string; documentation?: string; from: number; to: number }> | null {
  const at = operationAt(text, offset);
  if (!at?.inValue || !specs.length) return null;
  return operations(specs, 'get').map((o) => ({
    label: operationRef(o),
    detail: `GET ${operationUrl(o)}`,
    ...(o.summary || o.params.length ? { documentation: [o.summary, paramList(o)].filter(Boolean).join('\n\n') } : {}),
    from: at.from, to: at.to,
  }));
}

/** Markdown for a hover on `operation`: the method and absolute URL, as the spec has it and as the resource requests it. */
export function operationHover(text: string, offset: number, specs: OpenApiSpec[], specName: (file: string) => string): string | null {
  const at = operationAt(text, offset);
  if (!at || !specs.length) return null;
  const op = findOperation(specs, at.value);
  if ('closest' in op) return null;
  const url = operationUrl(op);
  const out = [`**${op.method.toUpperCase()}** \`${url}\``];
  const requested = requestedUrl(op, at.params);
  if (requested && requested !== url) out.push(`Requested as \`${requested}\``);
  if (op.summary) out.push(op.summary);
  const params = paramList(op);
  if (params) out.push(params);
  out.push(`From \`${specName(specs[op.spec]!.file)}\``);
  return out.join('\n\n');
}

const paramList = (o: Operation) => o.params.length
  ? 'Parameters: ' + o.params.map((p) => `\`${p.name}\` (${p.in}${p.in === 'query' && p.required ? ', required' : ''})`).join(', ')
  : '';

/** The URL with `params`' expressions in place of the parameters, as `src` would write it; null when `params` does not parse. */
function requestedUrl(op: Operation, params: string | null): string | null {
  const values = new Map<string, string>();
  if (params?.trim()) {
    let ast: acorn.Expression;
    try { ast = parseExpressionAt(params, 0, { ecmaVersion: 'latest' }) as acorn.Expression; } catch { return null; }
    if (ast.type !== 'ObjectExpression') return null;
    for (const p of ast.properties) {
      if (p.type !== 'Property' || p.computed) continue;
      const key = p.key.type === 'Identifier' ? p.key.name : p.key.type === 'Literal' ? String(p.key.value) : null;
      if (key !== null) values.set(key, params.slice(p.value.start, p.value.end));
    }
  }
  let url = operationUrl(op).replace(/\{([^}]+)\}/g, (m, n: string) => (values.has(n) ? `{${values.get(n)}}` : m));
  for (const p of op.params) {
    if (p.in !== 'query' || !values.has(p.name)) continue;
    url += `${url.includes('?') ? '&' : '?'}${p.name}={${values.get(p.name)}}`;
  }
  return url;
}
