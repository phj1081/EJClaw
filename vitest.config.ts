import path from 'path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      'bun:sqlite': path.resolve(__dirname, 'test/bun-sqlite-shim.ts'),
    },
  },
  test: {
    setupFiles: ['test/vitest-env.ts'],
    testTimeout: 15_000,
    include: [
      'src/**/*.test.ts',
      'apps/dashboard/src/**/*.test.ts',
      'setup/**/*.test.ts',
      'runners/**/test/**/*.test.ts',
    ],
  },
});
