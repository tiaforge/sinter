// The server's events are not in the OpenAPI file (it describes requests and responses), so the
// page names their payloads here; `Service` is the spec's schema: `type="ServiceEvent"` on <sn-event>.
import type {} from '@tiaforge-ui/temper/sinter';

/** `service_updated`: a whole service, when it is paused or resumed */
export interface ServiceEvent {
  service: Service;
}

/** `metric`: the numbers of one service now, four times a second. The history is not sent again: graphs append `rps`. */
export interface MetricEvent {
  id: string;
  status: Service['status'];
  rps: number;
  latencyMs: number;
  errorRate: number;
  at: number;
}
