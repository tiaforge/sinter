// What the engines offer a swap's same-document view transition: types (for a direction), the
// selector that styles by type, view-transition-class, and whether the stylesheet's
// @view-transition rule (temper's `navigation: auto`) is readable from script (CSSViewTransitionRule).
const pw = require('playwright');
const { createServer } = require('node:http');
const PAGE = `<!doctype html><title>x</title>
<style>@media (prefers-reduced-motion: no-preference) { @view-transition { navigation: auto; types: slide; } }</style><p>x</p>`;
const srv = createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end(PAGE); });
srv.listen(0, async () => {
  for (const w of ['chromium', 'firefox', 'webkit']) {
    const b = await pw[w].launch(), p = await b.newPage();
    await p.goto('http://127.0.0.1:' + srv.address().port + '/');
    const r = await p.evaluate(async () => {
      const out = {
        startViewTransition: typeof document.startViewTransition == 'function',
        typesSelector: CSS.supports('selector(:active-view-transition-type(slide))'),
        transitionClass: CSS.supports('view-transition-class', 'card'),
        ruleInterface: typeof CSSViewTransitionRule != 'undefined',
      };
      // the @view-transition rule, read from the sheet (inside its @media)
      const find = (rules) => { for (const r of rules) { if (r.constructor?.name == 'CSSViewTransitionRule') return r; if (r.cssRules) { const f = find(r.cssRules); if (f) return f; } } return null; };
      const rule = find(document.styleSheets[0].cssRules);
      out.ruleRead = rule ? { navigation: rule.navigation, types: [...(rule.types ?? [])] } : null;
      // a same-document transition with types: does the types selector match while it runs?
      try {
        const t = document.startViewTransition({ update() {}, types: ['sn-back'] });
        out.typesOnStart = !!t.types && [...t.types].includes('sn-back');
        out.typeMatches = (() => { try { return document.documentElement.matches(':active-view-transition-type(sn-back)'); } catch { return 'error'; } })();
        await t.finished.catch(() => {});
      } catch (e) { out.typesOnStart = 'error: ' + e.message; }
      return out;
    });
    console.log(w, b.version(), JSON.stringify(r));
    await b.close();
  }
  srv.close();
});
