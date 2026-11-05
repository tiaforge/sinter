// The rows every variant renders. Shared by the server (responses) and the page harness (expected
// state), so both agree on what "done" looks like.
//   scenario "replace": set a and set b have different ids (switching page or filter)
//   scenario "update":  same ids, every 10th label differs (reloading after an edit)
export function rows(n, scenario, v) {
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
