// Components with a script (docs/components.md): sinter creates the script's object once per
// instance, on the instance's root, when the root is created or adopted, and ends it when the root
// leaves the page. The markup is rendered by sinter; the script does browser work and writes state.
// Loaded only by pages that use such a component.
import type { App, Feature } from './runtime/app.js';

/**
 * The base of a component's script. A component's script extends the class generated from its HTML
 * (`import { TaskRingComponent } from './task-ring.html'`), which extends this one with its types.
 * `this` is not an element: it is an object sinter creates per instance.
 */
export class Component<P = Record<string, unknown>, E = Record<string, unknown>, R = Record<string, Element | undefined>, S = Record<string, unknown>> {
  /** the props, live: read them when needed (`propsChanged()` runs when one changed) */
  declare readonly props: Readonly<P>;
  /** the component's `data-sn-state`: assigning a field renders, as a handler does */
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

type Hooks = Partial<Record<'connected' | 'propsChanged' | 'disconnected', () => void>>;

interface Inst { obj: Component; root: Element; props: Record<string, unknown>; changed: boolean; connected: boolean }

const feature: Feature = {
  name: 'components',
  install(app: App) {
    const live = new Map<Element, Inst>();
    const run = (i: Inst, hook: 'connected' | 'propsChanged' | 'disconnected') => {
      try { (i.obj as unknown as Hooks)[hook]?.call(i.obj); } catch (e) { app.warn('component', hook, i.root, e); }
    };
    /** the elements of an instance's own markup with a ref: not those of nested components or slot content */
    const refs = (root: Element) => new Proxy({}, {
      get: (_, name) => typeof name == 'string'
        ? [...root.querySelectorAll(`[data-sn-r="${CSS.escape(name)}"]`)].find((x) => x.closest('[data-sn-c],[data-sn-s]') === root)
        : undefined,
    });
    /** the root's own state, written through: each assignment renders */
    const state = (root: Element) => {
      const h = app.state(root);
      return new Proxy(h.get() as Record<string, unknown>, {
        set: (_, k, v) => { h.update((s) => { (s as Record<string | symbol, unknown>)[k] = v; }); return true; },
      });
    };
    app.ext.components = (rb, v) => {
      const [mod, props, name] = v as [Record<string, unknown>, Record<string, unknown>, string];
      const el = rb.el;
      let i = live.get(el);
      if (!i) {
        const C = (mod[name] ?? mod.default) as (new () => Component) | undefined;
        if (typeof C != 'function') return void app.warn('component', 'class', el, name);
        const obj = new C();
        Object.defineProperties(obj, {
          props: { get: () => i!.props, configurable: true },
          state: { value: state(el), configurable: true },
          refs: { value: refs(el), configurable: true },
          root: { value: el, configurable: true },
        });
        live.set(el, (i = { obj, root: el, props, changed: false, connected: false }));
        return;
      }
      const prev = i.props;
      i.props = props;
      if (i.connected && Object.keys(props).some((k) => !Object.is(props[k], prev[k]))) i.changed = true;
    };
    // after each render: new instances connect, changed ones hear of it, removed ones end
    app.afterFlush.push(() => {
      for (const [el, i] of live) {
        if (!el.isConnected) { live.delete(el); if (i.connected) run(i, 'disconnected'); continue; }
        if (!i.connected) { i.connected = true; run(i, 'connected'); }
        else if (i.changed) { i.changed = false; run(i, 'propsChanged'); }
      }
    });
    app.addCleanup(() => { for (const i of live.values()) if (i.connected) run(i, 'disconnected'); live.clear(); });
  },
};
export default feature;
