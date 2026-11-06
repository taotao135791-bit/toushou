/** Pipeboard hosts this independent Meta connector; do not send Meta grants here. */
export const META_ADS_RESOURCE = 'https://meta-ads.mcp.pipeboard.co/'
export const META_ADS_ISSUER = 'https://meta-ads.mcp.pipeboard.co'
export const META_ADS_MCP_ENDPOINT = `${META_ADS_RESOURCE}?read_only=true`
export const META_ADS_RESOURCE_METADATA = `${META_ADS_ISSUER}/.well-known/oauth-protected-resource?platform=meta-ads`
export const META_ADS_AUTH_METADATA = `${META_ADS_ISSUER}/.well-known/oauth-authorization-server`
export const META_ADS_AUTHORIZE = 'https://pipeboard.co/oauth/authorize?platform=meta-ads'
export const META_ADS_TOKEN = 'https://pipeboard.co/oauth/token'
export const META_ADS_REGISTER = 'https://pipeboard.co/oauth/register?platform=meta-ads'
export { META_ADS_REDIRECT_URI } from '../../../shared/metaAds'
/** Deliberately omit creation, editing, audience and budget tools. */
export const META_ADS_TOOLS = ['get_ad_accounts', 'get_insights'] as const

/** Discovery is restricted to the observed provider endpoints, including query. */
export function validMetaEndpoint(value: unknown, purpose?: 'authorization' | 'token' | 'registration'): value is string {
  if (typeof value !== 'string') return false
  if (purpose === 'authorization') return value === META_ADS_AUTHORIZE
  if (purpose === 'token') return value === META_ADS_TOKEN
  if (purpose === 'registration') return value === META_ADS_REGISTER
  return [META_ADS_AUTHORIZE, META_ADS_TOKEN, META_ADS_REGISTER, META_ADS_RESOURCE_METADATA, META_ADS_AUTH_METADATA].includes(value)
}
