// a load hook: appends instrumentation to the compiler's modules; SN_COUNT=1 also counts calls inside the evaluation
import { readFileSync } from 'node:fs';
const C = process.env.SN_COUNT === '1';
const rep = (src, a, b) => { if (!src.includes(a)) throw new Error('hook: not found ' + a); return src.replace(a, b); };
export async function load(url, ctx, next) {
  const r = await next(url, ctx);
  if (url.endsWith('/dist/compiler/compile.js')) {
    let src = String(r.source ?? readFileSync(new URL(url)));
    if (C) {
      src = 'const __c = (globalThis.__snCount ??= {});\nconst __n = (k, d = 1) => { __c[k] = (__c[k] ?? 0) + d; };\n' + src;
      src = rep(src, 'const run = (sc, code) => {', 'const run = (sc, code) => { __n("row run");');
      src = rep(src, 'const mine = shared ? used.filter((c) => !shared.has(c)) : used;', 'const mine = shared ? used.filter((c) => !shared.has(c)) : used; __n("used", used.length); __n("mine", mine.length); __n("cands", cands.length); if (process.env.SN_MINE) console.error(mine.slice(0, 30).join("\\n"));');
      
      if (src.includes('const vals = rowFns ? progOf(nodes, L)?.(sc) : undefined;')) src = rep(src, 'const vals = rowFns ? progOf(nodes, L)?.(sc) : undefined;', 'const vals = rowFns ? progOf(nodes, L)?.(sc) : undefined; if (vals) { __n("row program calls"); __n("row program values", ROW_PARTS.get(nodes)?.list.length ?? 0); }');
      if (src.includes('const mine = this.placedUnit ? unitCands(this.placedUnit, this.tplEls, this.fns) : null;')) src = rep(src, 'const mine = this.placedUnit ? unitCands(this.placedUnit, this.tplEls, this.fns) : null;', 'const mine = this.placedUnit ? unitCands(this.placedUnit, this.tplEls, this.fns) : null; __n("unit cands " + (this.collecting() ? 1 : 2) + (this.placedUnit ? (mine ? " hit" : " miss") : " none")); __n("tplEls" + (this.collecting() ? 1 : 2), this.tplEls.size); __n("unit list", mine?.list.length ?? 0);');
      src = rep(src, 'const run = (code) => {', 'const run = (code) => { __n("top run");');
      src = rep(src, 'get: (_, p) => (p === t.item', 'get: (_, p) => (__n("row proxy get"), p === t.item');
      src = rep(src, 'const rowsOf = (t, items, key, sc, out, recs) => {', 'const rowsOf = (t, items, key, sc, out, recs) => { __n("rows walked", items.length);');
      src = rep(src, 'const render = (tid, rec) => {', 'const render = (tid, rec) => { __n("templates rendered");');
      src = rep(src, 'function writeFirstPaint(el, kind, name, v, fresh = false) {', 'function writeFirstPaint(el, kind, name, v, fresh = false) { __n("writeFirstPaint " + kind);');
    }
    return { ...r, source: src + '\n;globalThis.__snInstr?.(Compiler);\n' };
  }
  if (url.endsWith('/dist/compiler/index.js')) {
    const src = String(r.source ?? readFileSync(new URL(url)));
    return { ...r, source: src + '\n;compile = globalThis.__snWrap ? globalThis.__snWrap("compile()", compile) : compile;\n' };
  }
  return r;
}
