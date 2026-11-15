import { API } from '~lib/api.js';

export async function fetchData({ fetch, params }) {
  const r = await fetch(`${API}/incidents/${encodeURIComponent(params.id)}`);
  if (r.status === 404) return { incident: null, comments: [] };
  if (!r.ok) throw new Error(`the incident API answered ${r.status}`);
  const c = await fetch(`${API}/incidents/${encodeURIComponent(params.id)}/comments`);
  return { incident: (await r.json()).incident, comments: c.ok ? (await c.json()).comments : [] };
}
