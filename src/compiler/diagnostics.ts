export type Severity = 'error' | 'warning';

export interface Diagnostic {
  severity: Severity;
  code: string;
  message: string;
  file: string;
  line: number;
  col: number;
  hint?: string;
  /** what an editor underlines, when it is more than the name at `line:col` (a whole attribute, a tag name) */
  span?: { line: number; col: number; endLine: number; endCol: number };
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
  SN209: 'name-conflict',
  SN210: 'url-list-mismatch',
  SN211: 'url-list-condition',
  SN212: 'url-object-value',
  SN301: 'unknown-resource',
  SN302: 'duplicate-resource',
  SN303: 'unknown-meta-field',
  SN304: 'keyset-jump',
  SN306: 'component-cycle',
  SN307: 'openapi-invalid',
  SN308: 'unknown-schema-field',
  SN309: 'unknown-dialog',
  SN310: 'unknown-action',
  SN311: 'unknown-run-target',
  SN312: 'invalid-component',
  SN313: 'unknown-prop',
  SN314: 'unknown-slot',
  SN315: 'unknown-component-event',
  SN316: 'include-removed',
  SN317: 'no-item-source',
  SN318: 'invalid-layout',
  SN319: 'layout-use',
  SN320: 'head-content',
  SN321: 'duplicate-head',
  SN322: 'ships-javascript',
  SN323: 'needs-site',
  SN324: 'lazy-package-use',
  SN325: 'lazy-package-bundled',
  SN326: 'unknown-operation',
  SN327: 'undeclared-query',
  SN328: 'absolute-url',
  SN329: 'api-config',
  SN330: 'configured-shape',
  SN401: 'parse-error',
  SN501: 'unused-resource',
  SN502: 'non-reactive-value',
  SN503: 'data-bound-id',
  SN504: 'untyped-resource',
  SN505: 'unknown-query-param',
  SN506: 'untyped-event',
  SN507: 'complex-expression',
  SN509: 'run-cycle',
  SN510: 'redundant-write',
  SN511: 'image-too-small',
  SN512: 'image-stretched',
  SN513: 'bound-local-image',
  SN514: 'auto-fit-rows',
  SN515: 'redundant-path',
  SN516: 'unfed-live',
  SN517: 'unkeyed-list',
  SN518: 'redundant-shape',
  SN519: 'unused-preload',
  SN520: 'redirected-link',
  SN521: 'untranslated-messages',
  SN522: 'early-budget',
  SN523: 'redirects-limit',
  SN524: 'images-unoptimized',
  SN525: 'font-download',
  SN526: 'css-image-sizes',
  SN527: 'remote-image',
} as const;

export type Code = keyof typeof CODES;

export const DOCS_URL = 'https://github.com/tiaforge/sinter/blob/main/docs/diagnostics.md';

/** Link to a code's section of `docs/diagnostics.md` (GitHub's heading anchor). */
export function docsUrl(code: string): string {
  const name = CODES[code as Code];
  return `${DOCS_URL}#${code.toLowerCase()}${name ? `-${name}` : ''}`;
}

export function severityOf(code: Code): Severity {
  return code >= 'SN500' ? 'warning' : 'error';
}

/**
 * Warnings that depend on the machine or the network rather than on the project (a package not
 * installed, a download that failed): `--strict` does not turn them into errors, since a build
 * would then pass or fail with the network.
 */
export const ENVIRONMENT_CODES: ReadonlySet<string> = new Set(['SN524', 'SN525', 'SN526', 'SN527']);

/**
 * Warnings that are a measure, not a mistake: `--strict` leaves them warnings. `SN507` has its own
 * switch, `sinter({ complexity: { level: 'error' } })`.
 */
export const HEURISTIC_CODES: ReadonlySet<string> = new Set(['SN507']);

/** Whether `--strict` turns a warning with this code into an error (unless allowed). */
export function strictPromotes(code: string): boolean {
  return !ENVIRONMENT_CODES.has(code) && !HEURISTIC_CODES.has(code);
}

/**
 * `--strict`: the warnings become errors, except those of `ENVIRONMENT_CODES` and
 * `HEURISTIC_CODES` and the codes in `allow`. A promoted diagnostic keeps its code and says
 * `(strict)` in its hint.
 */
export function applyStrict(diagnostics: readonly Diagnostic[], allow: ReadonlySet<string> = new Set()): Diagnostic[] {
  return diagnostics.map((d) => {
    if (d.severity !== 'warning' || allow.has(d.code) || !strictPromotes(d.code)) return d;
    const note = `a warning, an error with --strict (\`--allow ${d.code}\` keeps it a warning)`;
    return { ...d, severity: 'error', hint: d.hint ? `${d.hint}; ${note}` : note };
  });
}

/** A build warning that has no place in a file (the build, a module, the config), as the Vite logger prints it. */
export function formatWarning(code: Code, message: string): string {
  return `sinter: warning ${code} ${CODES[code]}: ${message}\n  docs: ${docsUrl(code)}`;
}

/** Formats a diagnostic the way the terminal and the testing module print it. */
export function formatDiagnostic(d: Diagnostic): string {
  const name = CODES[d.code as Code] ?? '';
  let s = `${d.file}:${d.line}:${d.col} ${d.severity} ${d.code} ${name}: ${d.message}`;
  if (d.hint) s += `\n  hint: ${d.hint}`;
  return s + `\n  docs: ${docsUrl(d.code)}`;
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
