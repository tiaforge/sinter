// The rows every variant renders. Shared by the server (responses) and the page harness (expected
// state), so both agree on what "done" looks like.
//   scenario "replace": set a and set b have different ids (switching page or filter)
//   scenario "update":  same ids, every 10th label differs (reloading after an edit)
//   scenario "append":  set a is the base list; "c" is the rows added after it (load more)
export const added = (n) => Math.max(1, Math.round(n / 10));

export function rows(n, scenario, v) {
  if (scenario === 'append') {
    const from = v === 'c' ? n : 0, k = v === 'c' ? added(n) : n;
    return Array.from({ length: k }, (_, i) => ({ id: from + i, label: `row ${from + i}` }));
  }
  const out = new Array(n);
  for (let i = 0; i < n; i++) {
    if (scenario === 'replace') {
      const id = (v === 'a' ? 0 : n) + i;
      out[i] = { id, label: `row ${id}` };
    } else {
      out[i] = { id: i, label: i % 10 ? `row ${i}` : `row ${i} ${v}` };
    }
  }
  return out;
}
