// Positions in a source for messages: the build's checks report `file:line:col` from an offset into a module.

let last: { source: string; starts: number[] } | null = null;

/** 1-based line and column of an offset into a source; the source's line starts are kept for the next call on it */
export function lineCol(source: string, offset: number): { line: number; col: number } {
  if (last?.source !== source) {
    const starts = [0];
    for (let i = source.indexOf('\n'); i >= 0; i = source.indexOf('\n', i + 1)) starts.push(i + 1);
    last = { source, starts };
  }
  const { starts } = last;
  // the last line that starts at or before the offset (one past the end counts as the last line)
  const at = Math.min(offset, source.length);
  let lo = 0, hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid]! <= at) lo = mid; else hi = mid - 1;
  }
  return { line: lo + 1, col: offset - starts[lo]! + 1 };
}
