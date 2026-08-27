import { defineConfig } from 'vitest/config'
import path from 'node:path'

// Optional live provider smoke test (`pnpm test:omp:live`). Explicitly
// opt-in via OMP_GUI_RUN_LIVE_TESTS=1 — NEVER run by `pnpm test`,
// `pnpm test:omp`, or CI. Uses the machine's configured provider
// credentials and may consume tokens, so it is gated to a dedicated config
// that skips everything unless the opt-in env var is present.
export default defineConfig({
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src/renderer'),
      '@main': path.resolve(__dirname, 'src/main'),
      '@shared': path.resolve(__dirname, 'src/shared')
    }
  },
  test: {
    include: ['integration/**/*.live.test.ts', 'integration/**/*.provider.live.test.ts'],
    testTimeout: 120_000,
    hookTimeout: 30_000,
    pool: 'forks',
    maxConcurrency: 1,
    fileParallelism: false
  }
})