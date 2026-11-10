// The morph hold script: a classic script in the page's head script (see vite.ts). Node only: the
// code is a string. (The render-blocking fallback for browsers without `blocking` is gone: the early
// script renders as the parser inserts the elements, so no browser needs the paint held.)

/**
 * Holds the first paint while a morph is pending (`data-sn-transition`): the previous page named
 * an element (`sn:vt` in sessionStorage) and the browser captures this page at its first paint,
 * so the element with that name must be rendered by then. A classic script first in the head of
 * pages that use the attribute; it does nothing unless a name is pending (stored by the previous page
 * within the last 10 s, `PENDING_MAX` in transition.ts). Then it turns the page
 * module's tag, as the parser inserts it (a microtask checkpoint runs before a parser-inserted
 * script is prepared), from `async` into a deferred render-blocking module: it runs after the
 * parse, everything it awaits is settled by then, so it mounts in the same task, before the
 * first paint. Measured 2026-11-09 in Chromium with the module delayed 400 ms: first paint at
 * 35 ms without the element, with this at 420 ms with it.
 */
export const HOLD_SCRIPT = `(function(){try{var p=JSON.parse(sessionStorage.getItem("sn:vt")||"null");if(!p||!(Date.now()-p.t<=1e4))return;var d=document,o=new MutationObserver(function(r){r.forEach(function(x){x.addedNodes.forEach(function(n){if(n.localName=="script"&&n.type=="module"&&n.async){n.async=!1;n.removeAttribute("async");n.setAttribute("blocking","render")}})})});o.observe(d.documentElement,{childList:!0,subtree:!0});d.addEventListener("DOMContentLoaded",function(){o.disconnect()})}catch(x){}})();`;
