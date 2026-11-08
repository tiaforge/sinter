import { current } from './locale.js';
export const title = () => 'People';
export const unused = () => 'tree-shaken';
export const hello = () => (current === 'de' ? 'Hallo' : 'Hello');
