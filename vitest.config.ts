import path from 'path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      'bun:sqlite': path.resolve(__dirname, 'test/bun-sqlite-shim.ts'),
    },
  },
  test: {
    include: [
      'src/**/*.test.ts',
      'setup/**/*.test.ts',
      'runners/**/test/**/*.test.ts',
    ],
  },
});
