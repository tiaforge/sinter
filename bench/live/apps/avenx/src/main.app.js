// Avenx 1.0.0-rc.1: the dashboard as one component; the windows and bars replaced per tick, the
// hosts a deep Proxy array changed in place, like the Vue variant. Template and action free names
// resolve from the global scope, so the shared model's functions go on window.
import { AvenxApp } from 'avenx-core/runtime';
import * as model from '../../../shared/model.js';
import Dashboard from './components/dashboard/dashboard.component.js';

window.M = model;
const app = new AvenxApp({ target: '#app' });
app.register('Dashboard', Dashboard);
app.mount('Dashboard');
