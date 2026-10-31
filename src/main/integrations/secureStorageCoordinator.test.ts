import { describe, expect, it, vi } from 'vitest'
import { SecureStorageCoordinator, SecureStorageUnavailableError } from './secureStorageCoordinator'

function mockBackend() {
  return {
    isAvailable: vi.fn(() => true),
    encrypt: vi.fn((value: string) => Buffer.from(value)),
    decrypt: vi.fn((value: Buffer) => value.toString())
  }
}

describe('SecureStorageCoordinator', () => {
  it('blocks other queued stores after the first native failure', async () => {
    const coordinator = new SecureStorageCoordinator()
    const backend = mockBackend()
    backend.decrypt.mockImplementationOnce(() => { throw new Error('private native error') })
    const results = await Promise.allSettled([
      Promise.resolve().then(() => coordinator.decrypt(backend, Buffer.from('first'))),
      Promise.resolve().then(() => coordinator.decrypt(backend, Buffer.from('second'))),
      Promise.resolve().then(() => coordinator.encrypt(backend, 'third'))
    ])
    expect(results.every(result => result.status === 'rejected' && result.reason instanceof SecureStorageUnavailableError)).toBe(true)
    expect(backend.isAvailable).toHaveBeenCalledTimes(1)
    expect(backend.decrypt).toHaveBeenCalledTimes(1)
    expect(backend.encrypt).not.toHaveBeenCalled()
    expect(coordinator.isBlocked()).toBe(true)
  })

  it('latches an unavailable or throwing availability check without running the operation', () => {
    for (const availability of [() => false, () => { throw Error('native failure') }]) {
      const coordinator = new SecureStorageCoordinator()
      const backend = mockBackend()
      backend.isAvailable.mockImplementation(availability)
      expect(() => coordinator.encrypt(backend, 'secret')).toThrow(SecureStorageUnavailableError)
      expect(() => coordinator.decrypt(backend, Buffer.from('data'))).toThrow(SecureStorageUnavailableError)
      expect(backend.isAvailable).toHaveBeenCalledTimes(1)
      expect(backend.encrypt).not.toHaveBeenCalled()
      expect(backend.decrypt).not.toHaveBeenCalled()
    }
  })

  it('allows exactly one native transaction per explicit retry and unlocks only on success', () => {
    const coordinator = new SecureStorageCoordinator()
    const backend = mockBackend()
    backend.encrypt.mockImplementationOnce(() => { throw Error('failure') })
    expect(() => coordinator.encrypt(backend, 'value')).toThrow(SecureStorageUnavailableError)
    backend.decrypt.mockImplementationOnce(() => { throw Error('failure') })
    const failedEpoch = coordinator.blockedEpoch()
    expect(() => coordinator.decrypt(backend, Buffer.from('first'), { retry: true, retryEpoch: failedEpoch })).toThrow(SecureStorageUnavailableError)
    expect(coordinator.isBlocked()).toBe(true)
    expect(() => coordinator.decrypt(backend, Buffer.from('blocked'))).toThrow(SecureStorageUnavailableError)
    expect(backend.decrypt).toHaveBeenCalledTimes(1)
    expect(coordinator.decrypt(backend, Buffer.from('recovered'), { retry: true, retryEpoch: coordinator.blockedEpoch() })).toBe('recovered')
    expect(coordinator.isBlocked()).toBe(false)
    expect(coordinator.encrypt(backend, 'working')).toEqual(Buffer.from('working'))
  })

  it('does not let stale retry permissions bypass a later failure', () => {
    const coordinator = new SecureStorageCoordinator()
    const backend = mockBackend()
    const startedUnblocked = coordinator.blockedEpoch()
    backend.decrypt.mockImplementationOnce(() => { throw Error('failure A') })
    expect(() => coordinator.decrypt(backend, Buffer.from('A'))).toThrow(SecureStorageUnavailableError)
    const epochA = coordinator.blockedEpoch()
    expect(epochA).not.toBeNull()
    expect(() => coordinator.decrypt(backend, Buffer.from('stale'), { retry: true, retryEpoch: startedUnblocked })).toThrow(SecureStorageUnavailableError)
    expect(coordinator.decrypt(backend, Buffer.from('recovered'), { retry: true, retryEpoch: epochA })).toBe('recovered')
    backend.decrypt.mockImplementationOnce(() => { throw Error('failure B') })
    expect(() => coordinator.decrypt(backend, Buffer.from('B'))).toThrow(SecureStorageUnavailableError)
    const epochB = coordinator.blockedEpoch()
    expect(epochB).not.toBe(epochA)
    const callsBefore = backend.isAvailable.mock.calls.length
    expect(() => coordinator.decrypt(backend, Buffer.from('stale'), { retry: true, retryEpoch: epochA })).toThrow(SecureStorageUnavailableError)
    expect(() => coordinator.decrypt(backend, Buffer.from('missing epoch'), { retry: true })).toThrow(SecureStorageUnavailableError)
    expect(backend.isAvailable).toHaveBeenCalledTimes(callsBefore)
    expect(coordinator.blockedEpoch()).toBe(epochB)
    expect(coordinator.decrypt(backend, Buffer.from('new retry'), { retry: true, retryEpoch: epochB })).toBe('new retry')
  })

  it('does not turn a decrypted file format failure into a shared backend failure', () => {
    const coordinator = new SecureStorageCoordinator()
    const backend = mockBackend()
    const invalid = coordinator.decrypt(backend, Buffer.from('not-json'))
    expect(() => JSON.parse(invalid)).toThrow()
    expect(coordinator.isBlocked()).toBe(false)
    expect(coordinator.decrypt(backend, Buffer.from('{"other":"ok"}'))).toBe('{"other":"ok"}')
    expect(backend.decrypt).toHaveBeenCalledTimes(2)
  })
})
