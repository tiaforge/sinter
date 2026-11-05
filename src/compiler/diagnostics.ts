export type Severity = 'error' | 'warning';

export interface Diagnostic {
  severity: Severity;
  code: string;
  message: string;
  file: string;
  line: number;
  col: number;
  hint?: string;
}

export const CODES = {
  SN101: 'unknown-attribute',
  SN102: 'wrong-element',
  SN103: 'missing-key',
  SN104: 'unsupported-model',
  SN201: 'unknown-identifier',
  SN202: 'forbidden-global',
  SN203: 'side-effect',
  SN204: 'optimistic-scope',
  SN205: 'resource-mutation',
  SN206: 'unknown-namespace-member',
  SN207: 'unsafe-sink',
  SN208: 'type-error',
  SN301: 'unknown-resource',
  SN302: 'duplicate-resource',
  SN303: 'unknown-meta-field',
  SN304: 'keyset-jump',
  SN305: 'include-not-found',
  SN306: 'include-cycle',
  SN401: 'parse-error',
  SN501: 'unused-resource',
  SN502: 'non-reactive-value',
  SN503: 'data-bound-id',
  SN504: 'untyped-resource',
} as const;

export type Code = keyof typeof CODES;

export const DOCS_URL = 'https://sinter.tiaforge.dev/docs/diagnostics#';

export function severityOf(code: Code): Severity {
  return code >= 'SN500' ? 'warning' : 'error';
}

/** Formats a diagnostic the way the terminal and the testing module print it. */
export function formatDiagnostic(d: Diagnostic): string {
  const name = CODES[d.code as Code] ?? '';
  let s = `${d.file}:${d.line}:${d.col} ${d.severity} ${d.code} ${name}: ${d.message}`;
  if (d.hint) s += `\n  hint: ${d.hint}`;
  return s + `\n  docs: ${DOCS_URL}${d.code.toLowerCase()}`;
}

function distance(a: string, b: string): number {
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0]!;
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = prev[j]!;
      prev[j] = Math.min(prev[j]! + 1, prev[j - 1]! + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = tmp;
    }
  }
  return prev[b.length]!;
}

/** The closest candidate within a small edit distance, for "did you mean" messages. */
export function suggest(name: string, candidates: Iterable<string>): string | undefined {
  let best: string | undefined;
  let bestD = Math.max(2, Math.floor(name.length / 3)) + 1;
  for (const c of candidates) {
    const d = distance(name.toLowerCase(), c.toLowerCase());
    if (d < bestD) { best = c; bestD = d; }
  }
  return best;
}

export function didYouMean(name: string, candidates: Iterable<string>): string {
  const s = suggest(name, candidates);
  return s ? ` Did you mean \`${s}\`?` : '';
}
