// Functions the page's expressions call. Pure: the same arguments, the same result.

interface Running { paused: boolean; at: number; rps: number; latencyMs: number; errorRate: number; history: readonly number[] }

/** The running services' numbers added up (latency and error rate weighted by traffic). */
export function totals(services: readonly Running[]) {
  const live = services.filter((s) => !s.paused);
  const rps = live.reduce((n, s) => n + s.rps, 0);
  const weighted = (f: (s: Running) => number) => (rps ? live.reduce((n, s) => n + f(s) * s.rps, 0) / rps : 0);
  return { rps, at: Math.max(0, ...live.map((s) => s.at)), latencyMs: Math.round(weighted((s) => s.latencyMs)), errorRate: weighted((s) => s.errorRate) };
}

/** All services together, for the big chart's first frame: the samples added up position by position. */
export function combined(services: readonly Running[]): number[] {
  const length = Math.max(0, ...services.map((s) => s.history.length));
  return Array.from({ length }, (_, i) => services.reduce((n, s) => n + (s.history[i - length + s.history.length] ?? 0), 0));
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
export function tone(s: { paused: boolean; status: 'ok' | 'degraded' | 'down' }): 'neutral' | 'success' | 'warning' | 'danger' {
  return s.paused ? 'neutral' : ({ ok: 'success', degraded: 'warning', down: 'danger' } as const)[s.status];
}

/** The graph's color for a service that is slow or failing; none (the accent) when it is fine. */
export function graphTone(s: { paused: boolean; status: 'ok' | 'degraded' | 'down' }): 'warning' | 'danger' | undefined {
  return s.paused || s.status === 'ok' ? undefined : s.status === 'degraded' ? 'warning' : 'danger';
}
