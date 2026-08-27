import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'

/**
 * Zero-legacy-write guard, enforced statically at the exact boundary where
 * the two profiles meet: the profile-specific components.
 *
 * CurrentOmpSettings must never reference legacy file-backed mutation APIs
 * (auth.json / settings.json writers); LegacyPiSettings must never reference
 * current-runtime mutation APIs (omp config / runtime IPC). A regression
 * here means the GUI can silently write a config the runtime ignores — the
 * exact "fake success" class this codebase just eliminated.
 */

const CURRENT_SRC = 'src/renderer/components/CurrentOmpSettings.tsx'
const LEGACY_SRC = 'src/renderer/components/LegacyPiSettings.tsx'
const CURRENT_SECTION_SRC = [
  'src/renderer/components/RuntimeModelSection.tsx'
]

const LEGACY_MUTATIONS = [
  'setApiKey',
  'clearApiKey',
  'setModelConfig',
  'PI_SET_API_KEY',
  'PI_CLEAR_API_KEY',
  'PI_SET_MODEL_CONFIG',
  'piSettings',
  'syncMachineSkills'
]

const CURRENT_MUTATIONS = [
  'runtimeSetDefaultModel',
  'runtimeSetDefaultThinking',
  'runtimeSetMachineSkills',
  'authStartLogin',
  'authLogout',
  'RUNTIME_SET_DEFAULT_MODEL'
]

describe('zero-legacy-write static boundary', () => {
  it('CurrentOmpSettings references no legacy mutation API', () => {
    const src = readFileSync(CURRENT_SRC, 'utf-8')
    for (const forbidden of LEGACY_MUTATIONS) {
      expect(src.includes(forbidden), `${CURRENT_SRC} must not reference ${forbidden}`).toBe(false)
    }
  })

  it('current-profile sections reference no legacy mutation API', () => {
    for (const file of CURRENT_SECTION_SRC) {
      const src = readFileSync(file, 'utf-8')
      for (const forbidden of LEGACY_MUTATIONS) {
        expect(src.includes(forbidden), `${file} must not reference ${forbidden}`).toBe(false)
      }
    }
  })

  it('LegacyPiSettings references no current-runtime mutation API', () => {
    const src = readFileSync(LEGACY_SRC, 'utf-8')
    for (const forbidden of CURRENT_MUTATIONS) {
      expect(src.includes(forbidden), `${LEGACY_SRC} must not reference ${forbidden}`).toBe(false)
    }
  })
})
