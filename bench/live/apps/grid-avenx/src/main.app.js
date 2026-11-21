// Avenx 1.0.0-rc.1 grid: the rows a deep Proxy array changed in place, sorted at render time when
// ?sort=1 (like grid-vue). Template and action free names resolve from the global scope, so the
// shared model and the page's query go on window.
import { AvenxApp } from 'avenx-core/runtime';
import * as grid from '../../../shared/grid.js';
import Grid from './components/grid/grid.component.js';

window.G = grid;
window.Q = grid.params(location.search);
const app = new AvenxApp({ target: '#app' });
app.register('Grid', Grid);
app.mount('Grid');
