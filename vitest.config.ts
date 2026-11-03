import { defineConfig } from 'vitest/config'
import path from 'node:path'

// Default unit-test run: fast, hermetic, no real omp/pi processes.
// The real-binary compatibility suite lives in integration/omp and runs via
// `pnpm test:omp` (vitest.omp.config.ts).
export default defineConfig({
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src/renderer'),
      '@main': path.resolve(__dirname, 'src/main'),
      '@shared': path.resolve(__dirname, 'src/shared')
    }
  },
  test: {
    // Native Electron regressions share one desktop and its keyboard focus.
    // Running files in parallel can steal focus between real input events.
    fileParallelism: false,
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx']
  }
})
