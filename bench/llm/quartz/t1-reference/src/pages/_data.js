import { API } from '~lib/api.js';

// runs on the server for the first load and in the browser after that; never cached
export async function fetchData({ fetch }) {
  const r = await fetch(`${API}/incidents`);
  if (!r.ok) throw new Error(`the incident API answered ${r.status}`);
  return { incidents: (await r.json()).incidents };
}
