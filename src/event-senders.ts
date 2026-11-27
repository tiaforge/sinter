// Who can send an event on a page (docs/spec.md, Aliases): the build reads every module the page loads, from its entry
// points (the helpers, actions, config and early modules, the components' scripts, the page's own scripts) through
// every import, into packages, and finds each place that makes an event. A handler's `$event` then holds none of the
// page's objects (a DOM event's), or what the page's `emit()`s pass (an event sinter sends), only when every event of
// that name the page can see made carries no detail or one that holds none of the page's objects (script-values.ts). What it cannot read (a module it cannot find, an
// event made under a name that is no literal, a class that extends an event's, an event's detail written afterwards)
// makes every name untraceable: nothing is assumed of code the build did not read. sinter's own modules make the events
// of `emit()`, which the compiler reads in the markup.
import { readFileSync, statSync } from 'node:fs';
import { builtinModules } from 'node:module';
import { dirname, resolve, sep } from 'node:path';
import { resolveImport, selfPackage, FoldCache } from './fold-check.js';

const BROWSER = ['browser', 'production', 'import', 'module', 'default'];
import { parseModule } from './compiler/index.js';
import { lineCol } from './line-col.js';
import { allowedValue, moduleConsts } from './script-values.js';

/** What a page's modules send: `unknown`, why no name can be trusted (null: every one can); `risky`, by event name, why that one cannot. */
export interface EventSenders {
  unknown: string | null;
  risky: Map<string, string>;
}

type N = { type: string; start: number; end: number; [k: string]: any };
interface ModuleScan { stamp: string; imports: string[]; unknown: string | null; risky: Array<[string, string]> }

const scans = new Map<string, ModuleScan>();
const resolveCache = new FoldCache();

/** sinter's own modules: their events are `emit()`'s (read in the markup), sinter's own (`sn-*`) and a component script's `this.emit` (read in the script) */
const SINTER_DIR = resolve(dirname(new URL(import.meta.url).pathname), '..');
const ownModule = (f: string) => [`${SINTER_DIR}${sep}src${sep}`, `${SINTER_DIR}${sep}dist${sep}`].some((d) => f.startsWith(d)) && !f.includes(`${sep}node_modules${sep}`);
const STYLE = /\.(css|scss|sass|less|styl|svg|png|jpe?g|gif|webp|avif|woff2?|ttf|json|html|md|txt)(\?.*)?$/;

const literalName = (e: N | undefined): string | null => (e?.type === 'Literal' && typeof e.value === 'string' ? e.value
  : e?.type === 'TemplateLiteral' && !e.expressions.length ? e.quasis[0].value.cooked : null);
const EVENT_CLASS = /^(Custom|Mouse|Keyboard|Pointer|Focus|Input|Wheel|Touch|Drag|Clipboard|Composition|Ui|UI|Submit|Toggle|Animation|Transition|Progress|Error|Message|PopState|HashChange|PageTransition|Storage|Before[A-Za-z]*)?Event$/;

/** One module's events and imports (by its file, while its text is the same). */
function scanModule(file: string, text: string, root: string): ModuleScan {
  const imports: string[] = [];
  let unknown: string | null = null;
  const risky: Array<[string, string]> = [];
  const at = (n: N) => { const { line, col } = lineCol(text, n.start); return `${file.startsWith(root) ? file.slice(root.length + 1) : file}:${line}:${col}`; };
  const no = (why: string, n: N) => { unknown ??= `${why} (${at(n)})`; };
  let ast: N;
  try { ast = parseModule(text, file) as unknown as N; } catch (e) { return { stamp: '', imports, unknown: `\`${file}\` could not be read: ${(e as Error).message}`, risky }; }
  const consts = moduleConsts(ast);
  const source = (s: N | null | undefined, n: N) => {
    if (!s) return;
    const v = literalName(s);
    if (v === null) no('an `import()` of a module named by a value', n); else imports.push(v);
  };
  const event = (name: string | null, detail: N | null | false, n: N, cls: string) => {
    if (name === null) return no(`a \`new ${cls}(…)\` named by a value`, n);
    if (detail === false || allowedValue(detail, consts)) return;
    risky.push([name, `\`${name}\` is made with a detail the build cannot follow (${at(n)})`]);
  };
  const walk = (n: N | null | undefined, parent: N | null) => {
    if (!n || typeof n.type !== 'string') return;
    switch (n.type) {
      case 'ImportDeclaration': if (n.importKind !== 'type') source(n.source, n); break;
      case 'ExportNamedDeclaration': case 'ExportAllDeclaration': if (n.source && n.exportKind !== 'type') source(n.source, n); break;
      case 'ImportExpression': source(n.source, n); break;
      case 'NewExpression': {
        const c = n.callee.type === 'MemberExpression' && !n.callee.computed ? n.callee.property : n.callee;
        if (c.type === 'Identifier' && EVENT_CLASS.test(c.name)) {
          const init = n.arguments[1] as N | undefined;
          // only a CustomEvent keeps a detail as it was given (a UIEvent's is a number)
          const detail = c.name !== 'CustomEvent' ? false : !init ? false : init.type === 'ObjectExpression'
            ? (init.properties.some((p: N) => p.type !== 'Property') ? init : init.properties.find((p: N) => !p.computed && (p.key.name ?? p.key.value) === 'detail')?.value ?? false) : init;
          event(literalName(n.arguments[0]), detail, n, c.name);
        }
        break;
      }
      case 'ClassDeclaration': case 'ClassExpression':
        if (n.superClass?.type === 'Identifier' && EVENT_CLASS.test(n.superClass.name)) no(`a class that extends \`${n.superClass.name}\``, n);
        break;
      case 'CallExpression': {
        const c = n.callee;
        const m = c.type === 'MemberExpression' && !c.computed ? c.property.name : null;
        if (m === 'createEvent' || m === 'initCustomEvent' || m === 'initEvent') no(`\`${m}()\``, n);
        // a component script's own event (src/components.ts `emit`)
        if (m === 'emit' && c.object.type === 'ThisExpression') event(literalName(n.arguments[0]), n.arguments[1] ?? false, n, 'emit');
        // `Object.assign(event, { detail })` and friends
        if ((m === 'assign' || m === 'defineProperty' || m === 'defineProperties') && c.object.type === 'Identifier' && c.object.name === 'Object' && /\bdetail\b/.test(text.slice(n.start, n.end))) no('a `detail` set by `Object.' + m + '()`', n);
        break;
      }
      case 'AssignmentExpression':
        if (n.left.type === 'MemberExpression' && !n.left.computed && n.left.property.name === 'detail') no('a `detail` assigned', n);
        break;
      case 'Identifier':
        // an event class taken as a value (`const E = CustomEvent`, `window['CustomEvent']`): made out of sight
        if (EVENT_CLASS.test(n.name) && n.name !== 'Event' && parent && !(parent.type === 'NewExpression' && parent.callee === n)
          && !(parent.type === 'BinaryExpression' && parent.operator === 'instanceof') && !(parent.type === 'MemberExpression' && parent.property === n && !parent.computed)
          && !/^TS/.test(parent.type) && !(parent.type === 'ClassDeclaration' || parent.type === 'ClassExpression')) no(`\`${n.name}\` used as a value`, n);
        break;
    }
    for (const k in n) {
      if (k === 'type' || k === 'start' || k === 'end' || k === 'loc') continue;
      const v = n[k];
      if (Array.isArray(v)) for (const x of v) walk(x as N, n);
      else if (v && typeof v === 'object' && typeof (v as N).type === 'string') walk(v as N, n);
    }
  };
  walk(ast, null);
  return { stamp: '', imports, unknown, risky };
}

const stampOf = (f: string) => { const s = statSync(f); return `${s.mtimeMs}:${s.size}`; };

/**
 * The events the modules `entries` reach can send, read from their text (and `inline`: module texts by a name, a page's
 * inline scripts). A bare specifier is a package, resolved with production conditions; a module the build cannot find
 * or read makes every name untraceable.
 */
export function eventSenders(entries: string[], root: string, inline: Array<{ name: string; text: string }> = []): EventSenders {
  const out: EventSenders = { unknown: null, risky: new Map() };
  const seen = new Set<string>();
  const take = (s: ModuleScan, from: string) => {
    out.unknown ??= s.unknown;
    for (const [k, why] of s.risky) if (!out.risky.has(k)) out.risky.set(k, why);
    for (const spec of s.imports) {
      if (STYLE.test(spec) || spec.startsWith('virtual:') && /\bsinter\b/.test(spec)) continue;
      if (/^@tiaforge-ui\/sinter(\/|$)/.test(spec)) continue;
      // Node's own modules (a package's Node build): no DOM, no event of the page's
      if (spec.startsWith('node:') || builtinModules.includes(spec)) continue;
      // a package: both its builds, the browser's (what the bundle takes) and Node's, and the files its `browser` field
      // puts in place of others
      const f = resolveImport(spec, from, root, resolveCache), b = resolveImport(spec, from, root, resolveCache, BROWSER);
      if (!f && !b) { out.unknown ??= `\`${spec}\`, imported by \`${from.startsWith(root) ? from.slice(root.length + 1) : from}\`, could not be found`; continue; }
      for (const x of [f, b]) if (x) {
        const pkg = selfPackage(x), swaps = pkg?.json.browser;
        if (swaps && typeof swaps === 'object') for (const t of Object.values(swaps)) if (typeof t === 'string') visit(resolve(pkg!.dir, t));
        visit(x);
      }
    }
  };
  const visit = (f: string) => {
    if (seen.has(f) || ownModule(f) || STYLE.test(f)) return;
    seen.add(f);
    let s = scans.get(f);
    let stamp = '';
    try { stamp = stampOf(f); } catch { out.unknown ??= `\`${f}\` could not be read`; return; }
    if (!s || s.stamp !== stamp) {
      let text: string;
      try { text = readFileSync(f, 'utf8'); } catch { out.unknown ??= `\`${f}\` could not be read`; return; }
      s = { ...scanModule(f, text, root), stamp };
      scans.set(f, s);
    }
    take(s, f);
  };
  for (const e of entries) visit(e);
  for (const x of inline) take(scanModule(x.name, x.text, root), x.name);
  return out;
}
