import { configure, header } from '@tiaforge-ui/sinter';
configure({ request: [header('X-Sinter', '1')] });
