// The render-blocking fallback, for browsers without the `blocking` attribute (Firefox: bug
// 1751383). Node only: the code is a string, emitted as (part of) a classic script in the head.

/**
 * Runs while the head is parsed, in the page's first classic script (the language picker, or the
 * paint script on a page without messages), when its tag has `data-sn-early` (the page has an
 * early file). Where `blocking="render"` holds the first paint until the early file has rendered,
 * nothing happens. Without it, the browser paints the body as it is parsed (and resolves styles
 * before the stylesheets have applied), so what the early file renders (a persisted collapsed
 * rail, messages) would show in its unrendered state first, and CSS transitions would run from
 * that state. So, until the early file has rendered and the stylesheets have applied:
 * - `<html>` is `visibility: hidden` (set through CSSOM: no inline style for the CSP to refuse);
 *   2 s at most, then it shows whatever is there (as without this);
 * - transitions are off, through a constructed stylesheet (not subject to `style-src`); they
 *   come back after a layout flush, so nothing animates from a state that was never shown.
 *   Without the early file (it failed), the window's `load` ends both.
 * It meets the early file through the global the early file and the page module use
 * (`Symbol.for('sinter.early.page')`, see runtime/handoff.ts), creating it if it comes first.
 */
export const RENDER_FALLBACK = `(function(){try{var e=document.currentScript,d=document,h=d.documentElement,s=h.style,v=s.visibility,K=Symbol.for("sinter.early.page"),g=globalThis,m,c,o,n,t,f;if(!e||!e.hasAttribute("data-sn-early")||"blocking"in e)return;m=g[K]||(g[K]={started:!1,done:new Promise(function(r){f=r}),finish:function(){f()}});t=setTimeout(w,2e3);s.visibility="hidden";try{c=new CSSStyleSheet;c.replaceSync("*,::before,::after{transition:none!important}");d.adoptedStyleSheets=d.adoptedStyleSheets.concat(c)}catch(x){c=0}function w(){if(!o){o=1;clearTimeout(t);s.visibility=v}}function z(){if(n)return;n=1;w();h.getBoundingClientRect();if(c)d.adoptedStyleSheets=d.adoptedStyleSheets.filter(function(x){return x!=c})}m.done.then(function(){return Promise.all([].map.call(d.querySelectorAll('link[rel~="stylesheet"]'),function(l){return l.sheet||l.disabled||l.media&&!matchMedia(l.media).matches?0:new Promise(function(r){l.addEventListener("load",r);l.addEventListener("error",r)})}))}).then(z);addEventListener("load",z)}catch(x){}})();`;

/** The paint script: the fallback alone, for a page with an early file and no messages. */
export const PAINT_SCRIPT = `/* sinter paint */${RENDER_FALLBACK}\n`;
