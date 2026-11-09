// Types the pages name in `type="…"` on <sn-resource> and <sn-event>. `sinter check` (and every
// `vite build`) checks each expression against them: `t.titel` fails the build.
import type {} from '@tiaforge-ui/temper/sinter'; // temper's attribute values, for bound data-tone etc.

export interface Task {
  id: string;
  title: string;
  notes: string;
  done: boolean;
  /** ISO 8601 */
  createdAt: string;
}

/** `task_updated` on /api/events */
export interface TaskEvent {
  task: Task;
}

/** `task_removed` on /api/events */
export interface TaskRemoved {
  id: string;
}
