import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['server/__tests__/**/*.test.js', 'services/__tests__/**/*.test.ts', 'constants.test.ts'],
    testTimeout: 15000,
    hookTimeout: 15000,
  },
});
