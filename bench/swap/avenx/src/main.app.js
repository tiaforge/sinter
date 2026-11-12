// Avenx 1.0.0-rc.1: fetch JSON into Proxy state, render it with a keyed <@for>; c appends (like the
// Alpine and petite-vue pages). Actions resolve free names from the global scope, so the page's
// query goes on window.
import { AvenxApp } from 'avenx-core/runtime';
import Swap from './components/swap/swap.component.js';

window.Q = location.search.slice(1);
const app = new AvenxApp({ target: '#app' });
app.register('Swap', Swap);
app.mount('Swap');
