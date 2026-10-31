/** Native secure-storage operations are synchronous on the Electron version in use. */
export interface SecureStorageBackend {
  isAvailable(): boolean
  encrypt(value: string): Buffer
  decrypt(value: Buffer): string
}

/** No original native error is exposed: it may contain sensitive system details. */
export class SecureStorageUnavailableError extends Error {
  constructor() {
    super('secure credential storage is unavailable')
    this.name = 'SecureStorageUnavailableError'
  }
}

export interface SecureStorageAttempt {
  /** Only an explicit user retry may bypass the shared failure latch. */
  retry?: boolean
  /** Failure observed when the user initiated this specific retry. */
  retryEpoch?: number | null
}

/**
 * Process-wide gate for native Keychain/secure-storage calls. All methods are
 * synchronous: the failure latch is checked and updated within one call, so
 * queued callers cannot initiate another native prompt after a failure.
 * File reads, JSON parsing, and schema validation must stay outside this gate;
 * their failures are local to the affected file.
 */
export class SecureStorageCoordinator {
  private epoch = 0
  private blockedAt: number | null = null

  isBlocked(): boolean { return this.blockedAt !== null }
  blockedEpoch(): number | null { return this.blockedAt }

  decrypt(backend: SecureStorageBackend, value: Buffer, attempt: SecureStorageAttempt = {}): string {
    return this.execute(backend, () => backend.decrypt(value), attempt)
  }

  encrypt(backend: SecureStorageBackend, value: string, attempt: SecureStorageAttempt = {}): Buffer {
    return this.execute(backend, () => backend.encrypt(value), attempt)
  }

  private execute<T>(backend: SecureStorageBackend, operation: () => T, attempt: SecureStorageAttempt): T {
    if (this.blockedAt !== null && !(attempt.retry === true && attempt.retryEpoch === this.blockedAt)) {
      throw new SecureStorageUnavailableError()
    }
    try {
      if (!backend.isAvailable()) throw new Error('unavailable')
      const result = operation()
      this.blockedAt = null
      return result
    } catch {
      this.blockedAt = ++this.epoch
      throw new SecureStorageUnavailableError()
    }
  }
}

/** All application stores using the default Electron backend share this gate. */
export const secureStorageCoordinator = new SecureStorageCoordinator()
