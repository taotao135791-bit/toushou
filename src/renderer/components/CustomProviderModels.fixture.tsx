import { createRoot } from 'react-dom/client'
import type { RuntimeModelInfo } from '@shared/types'
import { useAppStore } from '../store'
import CurrentOmpSettings from './CurrentOmpSettings'

declare global {
  interface Window { modelSettingsCatalog: RuntimeModelInfo[] }
}

const catalog = window.modelSettingsCatalog
useAppStore.setState({
  language: 'en',
  runtimeOverview: {
    profile: 'current', machineSkillsState: 'disabled',
    providers: [...new Set(catalog.map(m => m.provider))].map(id => ({ id, name: id, authenticated: false, available: true })),
    capabilities: { providers: 'supported', nativeLogin: 'unsupported', logout: 'supported', modelCatalog: 'supported',
      defaultModelConfig: 'supported', defaultThinkingConfig: 'supported', machineSkillsConfig: 'supported' },
    modelState: { defaultModel: 'vendor/team/photo', defaultModelExplicit: true, defaultThinkingLevel: 'auto' }
  },
  runtimeModelCatalog: catalog,
  runtimeModels: [{ ...catalog[0], provider: 'relay', selector: 'relay/team/photo', input: ['text'], contextWindow: 131072 }],
  loadRuntimeOverview: async () => {},
  loadRuntimeModels: async () => {},
  loadRuntimeModelCatalog: async () => {}
})
createRoot(document.getElementById('root')!).render(<CurrentOmpSettings />)
