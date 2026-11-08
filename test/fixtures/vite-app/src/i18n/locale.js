// The messages' locale; the first-paint test switches it at build time (`locale.use`).
export let current = 'en';
export function setLocale(l) { current = l; }
