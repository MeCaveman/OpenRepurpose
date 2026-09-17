import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@openrepurpose/db': fileURLToPath(new URL('./packages/db/src/index.ts', import.meta.url)),
      '@openrepurpose/server': fileURLToPath(
        new URL('./apps/server/src/index.ts', import.meta.url),
      ),
      '@openrepurpose/shared': fileURLToPath(
        new URL('./packages/shared/src/index.ts', import.meta.url),
      ),
    },
  },
  test: {
    include: ['tests/unit/**/*.test.ts'],
    passWithNoTests: false,
  },
});
