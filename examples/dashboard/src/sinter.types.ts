// The server's events are not in the OpenAPI file (it describes requests and responses), so the
// page names their payloads here; `Service` is the spec's schema: `type="ServiceEvent"` on <sn-event>.
import type {} from '@tiaforge-ui/temper/sinter';

export interface ServiceEvent {
  service: Service;
}
