// a helper calling `m`: a page whose markup has no `m` still gets its language file
import { m } from '@tiaforge-ui/sinter/messages';
export const farewell = () => m.only_en();
