// The server's events are not in the OpenAPI file (it describes requests and responses), so the
// page names their payloads here: `type="ServiceEvent"` on <sn-event>. `Service` is the spec's
// schema. The `sample` event's payload is a `Sample`, which needs no type here.
import type {} from '@tiaforge-ui/temper/sinter';

/** `service_updated`: a service, when it is paused or resumed */
export interface ServiceEvent {
  service: Service;
}
