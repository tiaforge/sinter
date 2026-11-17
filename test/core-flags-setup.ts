// Each test starts on a core with no optional part: the pages it mounts turn on theirs (test/core-flags.ts).
import { beforeEach } from 'vitest';
import { reset } from './core-flags.js';

beforeEach(() => reset());
