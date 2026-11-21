// Avenx reference page for self.mjs: the benchmark's page as one Avenx component (see README).
import { AvenxApp } from 'avenx-core/runtime';
import { rows } from '../../src/sinter.helpers.js';
import Bench from './components/bench/bench.component.js';

// actions resolve free names from the global scope
window.buildRows = rows;

const app = new AvenxApp({ target: '#app' });
app.register('Bench', Bench);
app.mount('Bench');
