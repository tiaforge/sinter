import { configure, header } from '@tiaforge/sinter';
configure({ request: [header('X-Sinter', '1')] });
