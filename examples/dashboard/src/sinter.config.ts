import { configure } from '@tiaforge-ui/sinter';

configure({
  // A failed load or change that no page handled; an optimistic change has already been taken back.
  onError: (error) => console.error(error.message),
});
