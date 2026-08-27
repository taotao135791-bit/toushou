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
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx']
  }
})
