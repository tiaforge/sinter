// The did-you-mean quick fix. Both the compiler ("Did you mean `count`?") and
// TypeScript ("Did you mean 'title'?") put the suggestion in the message, next to
// the misspelled name; the fix replaces that name where the diagnostic points. A rename
// ("`start-page` is renamed to `page-model`") is fixed the same way.
import type { Range } from './server.js';

export interface TextEdit { range: Range; newText: string }

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

/** The suggestion and the misspelled name it replaces, from a diagnostic's message. */
export function suggestionOf(message: string): { wrong: string; right: string } | null {
  const r = /^`([^`]+)` is renamed to `([^`]+)`/.exec(message);
  if (r) return { wrong: r[1]!, right: r[2]! };
  const m = /Did you mean [`']([^`']+)[`']\?/.exec(message);
  if (!m) return null;
  const right = m[1]!;
  const before = message.slice(0, m.index);
  let best: { wrong: string; d: number } | null = null;
  for (const q of before.matchAll(/`([^`]+)`|'([^']+)'/g)) {
    // `m.inbox_titel`, `$meta.contacts.loadng`, `id="mark-raed"`: the suggestion replaces the last part
    const whole = q[1] ?? q[2]!;
    const wrong = /^[\w$-]+$/.test(right) ? whole.split(/[.\s/="<>]/).filter(Boolean).pop() ?? '' : whole;
    if (!wrong || wrong === right) continue;
    const d = distance(wrong, right);
    if (!best || d < best.d) best = { wrong, d };
  }
  return best ? { wrong: best.wrong, right } : null;
}

/**
 * The edit for a diagnostic: the occurrence of the misspelled name on the diagnostic's
 * lines that is nearest its start, replaced by the suggestion.
 */
export function didYouMeanEdit(text: string, range: Range, message: string): TextEdit | null {
  const s = suggestionOf(message);
  if (!s) return null;
  const lines = text.split('\n');
  let best: { line: number; at: number; d: number } | null = null;
  for (let l = range.start.line; l <= range.end.line && l < lines.length; l++) {
    const t = lines[l]!;
    for (let at = t.indexOf(s.wrong); at >= 0; at = t.indexOf(s.wrong, at + 1)) {
      // a whole name, not part of a longer one
      if (/[\w$]/.test(t[at - 1] ?? '') || /[\w$]/.test(t[at + s.wrong.length] ?? '')) continue;
      const d = l === range.start.line ? Math.abs(at - range.start.character) : 1e6 + at;
      if (!best || d < best.d) best = { line: l, at, d };
    }
  }
  if (!best) return null;
  return { range: { start: { line: best.line, character: best.at }, end: { line: best.line, character: best.at + s.wrong.length } }, newText: s.right };
}
