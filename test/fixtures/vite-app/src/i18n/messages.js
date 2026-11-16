// as an i18n library's message: it reads the language from outside, so it is the browser's (the build does not run it)
export const title = () => (globalThis.__lang === 'de' ? 'Leute' : 'People');
export const unused = () => 'tree-shaken';
