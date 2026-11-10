// App configuration, loaded by every page before it mounts.
import { configure } from '@tiaforge-ui/sinter';
import { toast } from './toast';

configure({
  // A failed load or action that no data-sn-catch handled: an optimistic change has already
  // been rolled back, so say why.
  onError: (error) => toast(error.message, 'danger'),
});
