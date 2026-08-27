import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeOverview } from '@shared/types'
import { useAppStore } from './index'

function overview(defaultModel: string, defaultThinkingLevel: string): RuntimeOverview {
  return {
    profile: 'current',
    capabilities: {
      providers: 'supported',
      nativeLogin: 'supported',
      logout: 'supported',
      modelCatalog: 'supported',
      defaultModelConfig: 'supported',
      defaultThinkingConfig: 'supported',
      machineSkillsConfig: 'supported'
    },
    providers: [],
    modelState: {
      defaultModel,
      defaultModelExplicit: Boolean(defaultModel),
      defaultThinkingLevel
    },
    machineSkillsState: 'disabled'
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((complete) => {
    resolve = complete
  })
  return { promise, resolve }
}

afterEach(() => {
  vi.unstubAllGlobals()
  useAppStore.setState({ runtimeOverview: null })
})

describe('runtime overview loading', () => {
  it('ignores an older overview response that settles after a forced refresh', async () => {
    const older = deferred<RuntimeOverview>()
    const newer = deferred<RuntimeOverview>()
    const runtimeOverview = vi
      .fn()
      .mockReturnValueOnce(older.promise)
      .mockReturnValueOnce(newer.promise)

    vi.stubGlobal('window', { electronAPI: { runtimeOverview } })

    const firstLoad = useAppStore.getState().loadRuntimeOverview()
    const forcedRefresh = useAppStore.getState().loadRuntimeOverview(true)

    newer.resolve(overview('deepseek/deepseek-v4', 'high'))
    await forcedRefresh
    older.resolve(overview('', 'auto'))
    await firstLoad

    expect(useAppStore.getState().runtimeOverview?.modelState).toMatchObject({
      defaultModel: 'deepseek/deepseek-v4',
      defaultThinkingLevel: 'high'
    })
  })
})
