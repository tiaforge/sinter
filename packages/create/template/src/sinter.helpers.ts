// Functions the pages' expressions can call. Keep them pure (the same arguments give the same
// result), so they can be unit-tested without a page.
import type { Task } from './sinter.types';

/** The tasks the list shows: `show` is 'all', 'open' or 'done'; `q` matches the title. */
export function visible(tasks: readonly Task[], q: string, show: string): Task[] {
  const query = q.trim().toLowerCase();
  return tasks.filter((t) =>
    (show === 'all' || t.done === (show === 'done')) && t.title.toLowerCase().includes(query));
}
