import type { FnSource, FnSources } from './compile.js';

/** A version 3 source map (https://tc39.es/ecma426/). */
export interface SourceMap {
  version: 3;
  sources: string[];
  sourcesContent: string[];
  names: string[];
  mappings: string;
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

function vlq(n: number): string {
  let v = n < 0 ? (-n << 1) | 1 : n << 1, out = '';
  do {
    let digit = v & 31;
    v >>>= 5;
    if (v) digit |= 32;
    out += B64[digit];
  } while (v);
  return out;
}

/**
 * Builds a module's text line by line and maps the lines that hold a compiled function to where
 * the function was written. A function maps as a whole: each of its lines points at the start of
 * its expression, so an error inside it is reported at the attribute it came from.
 */
export class MappedLines {
  readonly lines: string[] = [];
  private readonly marks: Array<{ line: number; col: number; src: FnSource }> = [];
  private line = 0;

  push(...lines: string[]) {
    for (const l of lines) { this.lines.push(l); this.line += 1 + count(l); }
  }

  /** one line holding a function: `indent`, the code, then `after` */
  fn(indent: string, code: string, after: string, src: FnSource | null | undefined) {
    if (src) {
      const n = count(code);
      for (let k = 0; k <= n; k++) this.marks.push({ line: this.line + k, col: k ? 0 : indent.length, src });
    }
    this.push(indent + code + after);
  }

  text(): string {
    return this.lines.join('\n') + '\n';
  }

  /** The map, or null when no function maps anywhere. `offset`: lines put before the module's text. */
  map(sources: FnSources | undefined, offset = 0): SourceMap | null {
    if (!sources || !this.marks.length) return null;
    const files = [...new Set(this.marks.map((m) => m.src.file))].sort();
    const index = new Map(files.map((f, i) => [f, i]));
    const rows: string[][] = [];
    let file = 0, line = 0, col = 0, genLine = -1, genCol = 0;
    for (const m of this.marks) {
      const row = (rows[m.line + offset] ??= []);
      const f = index.get(m.src.file)!, l = m.src.line - 1, c = m.src.col - 1;
      // the generated column restarts on each line; the source fields carry on from the previous segment
      if (m.line !== genLine) { genLine = m.line; genCol = 0; }
      row.push(vlq(m.col - genCol) + vlq(f - file) + vlq(l - line) + vlq(c - col));
      genCol = m.col; file = f; line = l; col = c;
    }
    const mappings = Array.from(rows, (r) => (r ?? []).join(',')).join(';');
    return { version: 3, sources: files, sourcesContent: files.map((f) => sources.content[f] ?? ''), names: [], mappings };
  }
}

function count(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) === 10) n++;
  return n;
}
