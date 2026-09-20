import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/**/*.test.ts', 'apps/**/*.test.ts', 'runner/**/*.test.ts', 'tests/**/*.test.ts'],
    environment: 'node',
    testTimeout: 15000,
  },
});
