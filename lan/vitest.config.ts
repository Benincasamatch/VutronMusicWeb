import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: [
      'packages/shared/tests/**/*.test.ts',
      'apps/server/tests/**/*.test.ts',
      'apps/web/tests/**/*.test.ts'
    ],
    exclude: ['**/node_modules/**', '**/dist/**'],
    clearMocks: true,
    restoreMocks: true,
    testTimeout: 10000,
    hookTimeout: 10000
  }
})
