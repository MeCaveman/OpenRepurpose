import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@openrepurpose/youtube': fileURLToPath(
        new URL('./integrations/youtube/src/index.ts', import.meta.url),
      ),
      '@openrepurpose/core': fileURLToPath(
        new URL('./packages/core/src/index.ts', import.meta.url),
      ),
      '@openrepurpose/media': fileURLToPath(
        new URL('./packages/media/src/index.ts', import.meta.url),
      ),
      '@openrepurpose/local-secrets': fileURLToPath(
        new URL('./packages/local-secrets/src/index.ts', import.meta.url),
      ),
      '@openrepurpose/db': fileURLToPath(new URL('./packages/db/src/index.ts', import.meta.url)),
      '@openrepurpose/platform-sdk': fileURLToPath(
        new URL('./packages/platform-sdk/src/index.ts', import.meta.url),
      ),
      '@openrepurpose/server': fileURLToPath(
        new URL('./apps/server/src/index.ts', import.meta.url),
      ),
      '@openrepurpose/testkit': fileURLToPath(
        new URL('./packages/testkit/src/index.ts', import.meta.url),
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
