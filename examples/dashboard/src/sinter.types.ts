// The server's events are not in the OpenAPI file (it describes requests and responses), so the
// page names their payloads here: `type="ServiceEvent"` on <sn-event>.
import type {} from '@tiaforge-ui/temper/sinter';

export interface ServiceEvent {
  service: {
    id: string;
    name: string;
    status: 'ok' | 'degraded' | 'down';
    paused: boolean;
    rps: number;
    latencyMs: number;
    errorRate: number;
    history: number[];
  };
}
