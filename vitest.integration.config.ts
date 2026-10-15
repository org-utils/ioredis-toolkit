import { configDefaults, defineConfig } from 'vitest/config';
// Declares the `scriptCacheMayBeFlushed` the projects provide.
import type {} from './tests/support/redis.js';

/**
 * Suites that flush the script cache of the servers every suite shares. A flush landing while another file counts its
 * commands turns that file's next EVALSHA into an extra EVAL, so these run in a group of their own, after all the others.
 * Files in that group still run in parallel with each other, so none of them may count commands.
 */
const SCRIPT_CACHE_FLUSHING_SUITES = ['tests/integration/scripts.integration.test.ts'];

export default defineConfig({
  test: {
    environment: 'node',
    testTimeout: 30_000,
    hookTimeout: 30_000,
    projects: [
      {
        extends: true,
        test: {
          name: 'integration',
          include: ['tests/integration/**/*.test.ts'],
          exclude: [...configDefaults.exclude, ...SCRIPT_CACHE_FLUSHING_SUITES],
          provide: { scriptCacheMayBeFlushed: false }
        }
      },
      {
        extends: true,
        test: {
          name: 'script-cache',
          include: SCRIPT_CACHE_FLUSHING_SUITES,
          provide: { scriptCacheMayBeFlushed: true },
          sequence: { groupOrder: 1 }
        }
      }
    ]
  }
});
