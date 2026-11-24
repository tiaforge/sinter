export async function load(url, ctx, next) {
  const r = await next(url, ctx);
  if (url.endsWith('/dist/compiler/index.js')) {
    const src = String(r.source ?? (await import('node:fs')).readFileSync(new URL(url)));
    return { ...r, source: src + '\n;compile = globalThis.__memWrap ? globalThis.__memWrap(compile) : compile;\n' };
  }
  return r;
}
