// App configuration, loaded by every page before it mounts. This is also where islands (custom
// elements for the browser work expressions cannot do) are imported.
import { configure } from '@tiaforge-ui/sinter';
import { toast } from './toast';
import './islands/task-chart';

configure({
  // A failed load or action that no data-sn-catch handled: an optimistic change has already
  // been rolled back, so say why.
  onError: (error) => toast(error.message, 'danger'),
});
