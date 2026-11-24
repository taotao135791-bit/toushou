import type { CustomProviderApi, RuntimeModelInfo } from './types'

export const GENERIC_CUSTOM_PROVIDER_APIS = ['openai-completions', 'openai-responses', 'anthropic-messages'] as const
export const CATALOG_CUSTOM_PROVIDER_APIS = [...GENERIC_CUSTOM_PROVIDER_APIS, 'google-generative-ai'] as const

export function isCustomProviderApi(value: unknown): value is CustomProviderApi {
  return CATALOG_CUSTOM_PROVIDER_APIS.some(api => api === value)
}

export function matchesCatalogEndpoint(
  model: RuntimeModelInfo,
  provider: { id: string; baseUrl: string; api: string }
): boolean {
  const endpoint = provider.baseUrl.trim().replace(/\/+$/, '')
  return !!endpoint && !!provider.api && model.provider === provider.id &&
    model.api === provider.api && model.baseUrl?.replace(/\/+$/, '') === endpoint
}

/** Look up a wire model ID only within the named provider, API and endpoint. */
export function findCustomCatalogModel(
  catalog: readonly RuntimeModelInfo[],
  provider: { id: string; baseUrl: string; api: string },
  modelId: string
): RuntimeModelInfo | undefined {
  return catalog.find(model => model.id === modelId && matchesCatalogEndpoint(model, provider))
}

export function modelTokenLimit(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : undefined
}
