// Components with a script (docs/components.md): sinter creates the script's object once per
// instance, on the instance's root, when the root is created or adopted, and ends it when the root
// leaves the page. The markup is rendered by sinter; the script does browser work and writes state.
// The compiler gives the root a `cmp` binding (the module, the props, the class name) and each
// `data-sn-ref` element one (the root's state, the ref's name). Loaded only by pages that use such
// a component.
import { STATE, type App, type Feature, type Tagged } from './runtime/app.js';
import type { SinterError } from './runtime/config.js';

/**
 * The base of a component's script. A component's script extends the class generated from its HTML
 * (`import { TaskRingComponent } from './task-ring.html'`), which extends this one with its types.
 * `this` is not an element: it is an object sinter creates per instance.
 */
export class Component<P = Record<string, unknown>, E = Record<string, unknown>, R = Record<string, Element | undefined>, S = Record<string, unknown>> {
  /** the props, live: read them when needed (`propsChanged()` runs when one changed) */
  declare readonly props: Readonly<P>;
  /** the component's `data-sn-state`: assigning a field renders that field, as a handler does */
  declare readonly state: S;
  /** elements of the component's markup with `data-sn-ref="name"`; one inside a template that is not rendered is undefined */
  declare readonly refs: Readonly<R>;
  /** the instance's root element */
  declare readonly root: HTMLElement;
  /** dispatches a declared event (`data-sn-emits`) from the root: bubbling and cancelable, as `emit()` in markup */
  emit<K extends keyof E & string>(name: K, ...detail: undefined extends E[K] ? [E[K]?] : [E[K]]): boolean {
    return this.root.dispatchEvent(new CustomEvent(name, { detail: detail[0], bubbles: true, cancelable: true }));
  }
  // The hooks a script defines, which sinter calls (not declared here, so a script writes them without
  // `override`): `connected()` once the markup is rendered or adopted (refs are set); `propsChanged()`
  // once per render in which a prop changed; `disconnected()` when sinter removes the instance (its
  // row, its `data-sn-if` branch, or the page).
}

type Hook = 'connected' | 'propsChanged' | 'disconnected';
interface Inst { o: any; p: Record<string, unknown>; c: 0 | 1 | 2 }

const feature: Feature = {
  name: 'components',
  install(app: App) {
    const live = new Map<Element, Inst>();
    /** roots whose script loads with lazy packages (`a.l`): the latest props until it has loaded */
    const waiting = new Map<Element, { p: Record<string, unknown> }>();
    /** by root state: the refs of its instance (the elements its markup's ref bindings gave) */
    const refsOf = new WeakMap<object, Record<string, Element>>();
    const refs = (st: object) => refsOf.get(st) ?? (refsOf.set(st, {}), refsOf.get(st)!);
    const run = (el: Element, i: Inst, hook: Hook) => {
      try { i.o[hook]?.(); } catch (e) { app.warn('component', hook, el, e); }
    };
    app.ext.components = ({ el, b: { w } }, v) => {
      const [a, b, keys] = v as [any, any, string[] | undefined];
      // a ref: `[the root's state, its name]`
      if (!keys) return void (refs(a)[b] = el);
      const i = live.get(el);
      if (i) {
        // after the render: `propsChanged()` once, when a prop is another value
        if (i.c && Object.keys(b).some((k) => !Object.is(b[k], i.p[k]))) i.c = 2;
        i.p = b;
        return;
      }
      // a script that loads with lazy packages: the instance starts once it has loaded, with the props
      // of that moment, and connects at once (the markup is rendered); one that left the page meanwhile never starts
      if (a.l) {
        const x = waiting.get(el);
        if (x) return void (x.p = b);
        waiting.set(el, { p: b });
        a().then((cls: any) => {
          const x = waiting.get(el);
          if (!x || !waiting.delete(el) || !el.isConnected) return;
          const i = create(el, cls, x.p, keys, w);
          i.c = 1;
          run(el, i, 'connected');
        }, (e: SinterError) => { waiting.delete(el); app.unhandled(e, el); });
        return;
      }
      // `a`: the class, which the compiler imported
      create(el, a, b, keys, w);
    };
    const create = (el: Element, a: any, b: Record<string, unknown>, keys: string[], w: unknown[] | undefined) => {
      const obj = (el as Tagged)[STATE]![1], state = {}, o = new a(), x: Inst = { o, p: b, c: 0 };
      // the root's state, each field written through: an assignment marks that field (`w`: its path, by the order of `keys`)
      keys.forEach((k, j) => Object.defineProperty(state, k, { get: () => obj[k], set: (v) => { obj[k] = v; app.mark(w![j] as number); } }));
      Object.defineProperties(o, { props: { get: () => x.p }, state: { value: state }, refs: { value: refs(obj) }, root: { value: el } });
      live.set(el, x);
      return x;
    };
    // after each render: new instances connect, changed ones hear of it, removed ones end; refs that left the page go
    app.afterFlush.push(() => {
      for (const [el, i] of live) {
        if (!el.isConnected) { live.delete(el); if (i.c) run(el, i, 'disconnected'); continue; }
        const r = i.o.refs as Record<string, Element>;
        for (const k in r) if (!r[k]!.isConnected) delete r[k];
        if (!i.c) { i.c = 1; run(el, i, 'connected'); }
        else if (i.c == 2) { i.c = 1; run(el, i, 'propsChanged'); }
      }
    });
    app.addCleanup(() => { for (const [el, i] of live) if (i.c) run(el, i, 'disconnected'); live.clear(); waiting.clear(); });
  },
};
export default feature;
