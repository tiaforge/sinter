// Shared definitions (docs/components.md): a component used inside itself, or chosen by
// `<sn-component use>`, is one `<template id="sn-def-…">` in the head. Each use is an empty
// `<template data-sn-def>`, which gets the definition before it is first cloned. Loaded only by
// pages that have one.
import type { App, Feature } from './runtime/app.js';

const feature: Feature = {
  name: 'defs',
  install(app: App) {
    app.ext.defs = (tpl) => {
      const id = tpl.getAttribute('data-sn-def');
      if (id && !tpl.content.firstChild) tpl.content.append((tpl.ownerDocument.getElementById(id) as HTMLTemplateElement).content.cloneNode(true));
    };
  },
};
export default feature;
