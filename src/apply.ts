// Write-through: a mutation's 2xx response is applied to the resources it is about, before `then`
// runs. What it is about comes from the compiler (`ActionDef.ap`): the resources, rows and nested
// entities the URL and body read (provenance), the response's objects of named schemas, and the
// request body's wrapper. Rules: 1 confirm (response objects of a schema patch same-key items and
// what the URL named), 2 create (a POST to a list's URL inserts the created item: the response's
// item, else body + key, else a refetch), 3 update (the body patches what the URL named),
// 4 delete (a DELETE of a row's URL removes the row). `then` writes land on top of all of it.
import type { ApplyDef } from './ir.js';
import type { App, Feature } from './runtime/app.js';

type Target = ApplyDef['tg'][number];
const isObj = (v: unknown): v is Record<string, any> => !!v && typeof v == 'object' && !Array.isArray(v);
const at = (o: any, p: string[]): any => p.reduce((x, k) => (x == null ? x : x[k]), o);
/** `fields` merged into the object at `p` inside `item`, as a patch of the item: `{ author: { ...item.author, ...fields } }`. */
const nest = (item: any, p: string[], fields: Record<string, any>): Record<string, any> =>
  p.length ? { [p[0]!]: { ...(isObj(item?.[p[0]!]) ? item[p[0]!] : {}), ...nest(item?.[p[0]!], p.slice(1), fields) } } : fields;

/** The fields of `fields` whose value differs from what `current` holds at `p` (JSON equality); null when none does. */
function changed(current: unknown, p: string[], fields: Record<string, any>): Record<string, any> | null {
  const cur = at(current, p);
  let out: Record<string, any> | null = null;
  for (const k of Object.keys(fields)) {
    if (!isObj(cur) || !(k in cur) || JSON.stringify(cur[k]) !== JSON.stringify(fields[k])) (out ??= {})[k] = fields[k];
  }
  return out;
}

const apply: Feature = {
  name: 'apply',
  install(app: App) {
    const schemaOf = new Map(app.ir.resources.filter((r) => r.sch).map((r) => [r.name, r.sch!]));
    app.ext.apply = (a, s, url, body, result) => {
      const ap = a.ap!, m = a.method, done: string[] = [];
      const res = (n: string) => app.resource(n);
      const unwrap = (b: unknown) => (ap.rq && isObj(b) ? b[ap.rq] : b);
      const log = (name: string, what: string) => done.push(`${name}: ${what}`);
      /** the item a target names: the row, or the single object */
      const itemOf = (t: Target) => (t.v ? s[t.v] : res(t.r).value());
      /**
       * Merges `fields` into what a target names (at its sub-path), if the store still has it. Fields that
       * already hold the value are left out: a base write to an item drops a waiting layer's changes to it,
       * so a confirmation that changes nothing must write nothing.
       */
      const patchAt = (t: Target, fields: unknown) => {
        // a nested item: the nested module, loaded by the pages that have one
        if (t.n) return app.ext.nested!.wt(t, s, fields, log);
        const r = res(t.r), item = itemOf(t);
        if (!isObj(item) || !isObj(fields) || (r.isCollection && !r.has(item))) return;
        const diff = changed(r.isCollection ? r.get(item) : r.value(), t.p ?? [], fields);
        if (!diff) return;
        r.patch(item, nest(item, t.p ?? [], diff));
        log(t.r, `patch${t.p?.length ? ' .' + t.p.join('.') : ''}`);
      };
      // 3 update: the body describes the entity the URL named
      if ((m == 'PUT' || m == 'PATCH') && isObj(body)) {
        const b = unwrap(body);
        if (ap.u != null) patchAt(ap.tg[ap.u]!, b);
        // without a spec: the body's keys must be fields the item already has
        else if (!ap.t && isObj(b)) for (const t of ap.tg) { const item = itemOf(t); if (!t.p && isObj(item) && Object.keys(b).every((k) => k in item)) patchAt(t, b); }
      }
      // 1 confirm: objects of a named schema go to what the URL named, and to every list of that schema holding the key
      for (const e of ap.rs ?? []) {
        const v = at(result, e.p ? e.p.split('.') : []);
        for (const o of e.a ? (Array.isArray(v) ? v : []) : [v]) {
          if (!isObj(o)) continue;
          for (const t of ap.tg) if (t.s == e.s) patchAt(t, o);
          for (const [name, sch] of schemaOf) {
            const r = res(name);
            if (sch == e.s && r.isCollection && r.key?.every((k) => k in o) && r.has(o)) { const d = changed(r.get(o), [], o); if (d) { r.patch(o, d); log(name, 'patch'); } }
          }
        }
      }
      // 2 create: a POST to a list's own URL
      if (m == 'POST' && ap.t) for (const def of app.ir.resources) {
        const r = res(def.name);
        if (!r.isCollection || !r.key || r.loader?.url?.() !== url) continue;
        const e = ap.rs?.find((x) => x.s == def.sch);
        if (e) {
          const v = at(result, e.p ? e.p.split('.') : []);
          for (const o of e.a ? (Array.isArray(v) ? v : []) : [v]) if (isObj(o)) { r.upsert(o); log(def.name, 'upsert'); }
          continue;
        }
        // the key came back (`{id: 42}`, or wrapped): the item is what was sent plus the response
        const b = unwrap(body), key = [result, ...(isObj(result) ? Object.values(result) : [])].find((c) => isObj(c) && r.key!.every((k) => k in c));
        if (key && isObj(b)) { r.upsert({ ...b, ...key }); log(def.name, 'upsert body+key'); }
        else { void r.refetch(); log(def.name, 'refetch'); }
      }
      // 4 delete: the row whose URL this was
      if (m == 'DELETE') for (const t of ap.tg) {
        if (!t.v || t.p?.length) continue;
        const r = res(t.r), lu = r.loader?.url?.(), i = url.lastIndexOf('/'), row = s[t.v];
        if (t.n) { if (lu != null && i > 0 && url.slice(0, i) == lu) app.ext.nested!.wt(t, s, null, log); continue; }
        if (r.isCollection && lu != null && i > 0 && url.slice(0, i) == lu && isObj(row) && r.has(row)) { r.remove(row); log(t.r, 'remove'); }
      }
      if (done.length) app.warn(21, `${m} ${url}`, done.join(', '));
    };
  },
};

export default apply;
