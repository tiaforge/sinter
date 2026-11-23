// The server's events are not in the OpenAPI file (it describes requests and responses), so the
// page names their payloads here: `type="ServiceEvent"` on <sn-event>. The `sample` event's payload is a
// `Sample`, which needs no type here.
import type {} from '@tiaforge-ui/temper/sinter';

/** `service_updated`: a service, when it is paused or resumed */
export interface ServiceEvent {
  /** the spec's `Service` (server/openapi.yml), written out: the spec's schemas are types in the pages, not in this module */
  service: { id: string; name: string; paused: boolean };
}
