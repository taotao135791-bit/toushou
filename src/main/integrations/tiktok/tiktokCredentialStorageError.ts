/** Existing encrypted credentials could not be safely accessed. */
export class TikTokCredentialStorageError extends Error {
  readonly code = 'tiktok-credential-storage-unavailable'
  constructor() {
    super('TikTok 凭据无法从系统钥匙串读取；原凭据已保留，请检查钥匙串后在连接页面重试。')
    this.name = 'TikTokCredentialStorageError'
  }
}
