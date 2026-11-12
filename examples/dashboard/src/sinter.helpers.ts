// Functions the page's expressions call. Pure: the same arguments, the same result.

interface Sample { service: string; tick: number; status: 'ok' | 'degraded' | 'down'; rps: number; latencyMs: number; errorRate: number }

/** One service's samples, oldest first (the resource is ordered by `at`). */
export function of<T extends { service: string }>(samples: readonly T[], id: string): T[] {
  return samples.filter((s) => s.service === id);
}

/** The running services' newest numbers added up (latency and error rate weighted by traffic). */
export function totals(services: readonly { id: string; paused: boolean }[], samples: readonly Sample[]) {
  const newest = new Map<string, Sample>();
  for (const s of samples) newest.set(s.service, s);
  const live = services.filter((s) => !s.paused && newest.has(s.id)).map((s) => newest.get(s.id)!);
  const rps = live.reduce((n, s) => n + s.rps, 0);
  const weighted = (f: (s: Sample) => number) => (rps ? live.reduce((n, s) => n + f(s) * s.rps, 0) / rps : 0);
  return { rps, tick: Math.max(0, ...live.map((s) => s.tick)), latencyMs: Math.round(weighted((s) => s.latencyMs)), errorRate: weighted((s) => s.errorRate) };
}

/** Requests per second of all services together, round by round, for the big chart. */
export function combined(samples: readonly Sample[], rounds = 121): number[] {
  const byTick = new Map<number, number>();
  for (const s of samples) byTick.set(s.tick, (byTick.get(s.tick) ?? 0) + s.rps);
  return [...byTick].sort((a, b) => a[0] - b[0]).slice(-rounds).map(([, rps]) => rps);
}

/** A service's requests per second, round by round. */
export function rates(samples: readonly Sample[]): number[] {
  return samples.map((s) => s.rps);
}

/** The points of an SVG polyline drawing `values` in a `w` × `h` box, from 0 up to `max` (the highest value by default). */
export function line(values: readonly number[], w: number, h: number, max = Math.max(1, ...values)): string {
  const step = values.length > 1 ? w / (values.length - 1) : 0;
  return values.map((v, i) => `${(i * step).toFixed(1)},${(h - (v / max) * h).toFixed(1)}`).join(' ');
}

/** The same line closed along the bottom, to fill. */
export function area(values: readonly number[], w: number, h: number, max?: number): string {
  return values.length ? `0,${h} ${line(values, w, h, max)} ${w},${h}` : '';
}

export function percent(share: number): string {
  return (share * 100).toFixed(1) + '%';
}

/** temper's tone for a service's badge. */
export function tone(paused: boolean, status: 'ok' | 'degraded' | 'down'): 'neutral' | 'success' | 'warning' | 'danger' {
  return paused ? 'neutral' : ({ ok: 'success', degraded: 'warning', down: 'danger' } as const)[status];
}

/** The graph's color for a service that is slow or failing; none (the accent) when it is fine. */
export function graphTone(paused: boolean, status: 'ok' | 'degraded' | 'down'): 'warning' | 'danger' | undefined {
  return paused || status === 'ok' ? undefined : status === 'degraded' ? 'warning' : 'danger';
}
