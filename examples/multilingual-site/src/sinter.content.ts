// The site's languages and its messages, from the inlang project (project.inlang): `m.key()` in the pages.
import { languages } from '@tiaforge-ui/sinter/content';
import { inlang, inlangLocales } from '@tiaforge-ui/sinter/messages/content';

export const locales = languages(({ root }) => inlangLocales('project.inlang', root));
export const messages = inlang();
