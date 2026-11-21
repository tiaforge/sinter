// The pages' languages and messages, from the inlang project: each language's pages under its prefix.
import { languages } from '@tiaforge-ui/sinter/content';
import { inlang, inlangLocales } from '@tiaforge-ui/sinter/messages/content';

export const locales = languages(({ root }) => inlangLocales('project.inlang', root));
export const messages = inlang();
