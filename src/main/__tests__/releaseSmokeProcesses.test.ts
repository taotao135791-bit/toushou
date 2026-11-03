import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'
const require_ = createRequire(import.meta.url)
const { normalizeProcesses, captureProcessTree, processesGone } = require_('../../../tools/release-smoke-processes.cjs') as {
  normalizeProcesses: (input: unknown) => Row[]
  captureProcessTree: (rows: Row[], pid: number, executable: string) => Array<{ pid: number; birth: string }>
  processesGone: (tracked: Array<{ pid: number; birth: string }>, rows: Row[], executable: string) => boolean
}
type Row = { pid: number; parent: number; birth: string | null; image: string | null }
const executable = 'C:\\fixture\\投手.exe'
const rows: Row[] = [
  { pid: 10, parent: 1, birth: '100', image: executable },
  { pid: 11, parent: 10, birth: '110', image: executable },
  { pid: 12, parent: 11, birth: '120', image: 'C:\\fixture\\worker.exe' },
  { pid: 13, parent: 99, birth: '130', image: 'c:\\FIXTURE\\投手.exe' },
  { pid: 99, parent: 1, birth: '990', image: 'C:\\other.exe' }
]

describe('Windows smoke process verification', () => {
  it('tracks the original process tree and staged app instances, but not unrelated processes', () => {
    expect(captureProcessTree(rows, 10, executable)).toEqual([{ pid: 10, birth: '100' }, { pid: 11, birth: '110' }, { pid: 12, birth: '120' }, { pid: 13, birth: '130' }])
  })
  it('fails closed for survivors, missing identity, or an unverified root', () => {
    const tracked = captureProcessTree(rows, 10, executable)
    expect(processesGone(tracked, [rows[2]], executable)).toBe(false)
    expect(processesGone(tracked, [{ ...rows[2], birth: null }], executable)).toBe(false)
    expect(processesGone(tracked, [{ ...rows[3], pid: 20 }], executable)).toBe(false)
    expect(() => captureProcessTree(rows, 999, executable)).toThrow('root-unverified')
    expect(() => captureProcessTree(rows.map(r => r.pid === 12 ? { ...r, birth: null } : r), 10, executable)).toThrow('identity-unavailable')
  })
  it('distinguishes PID reuse by creation time and rejects malformed enumerations', () => {
    const tracked = captureProcessTree(rows, 10, executable)
    expect(processesGone(tracked, [{ ...rows[2], birth: '999', image: 'C:\\other.exe' }, rows[4]], executable)).toBe(true)
    expect(() => normalizeProcesses([])).toThrow('invalid')
    expect(() => normalizeProcesses([{ pid: 3, parent: 0 }, { pid: 3, parent: 0 }])).toThrow('invalid')
    expect(normalizeProcesses([{ pid: 0, parent: 0 }, { pid: 3, parent: 0, birth: '34', image: null }])).toEqual([{ pid: 0, parent: 0, birth: null, image: null }, { pid: 3, parent: 0, birth: '34', image: null }])
  })
})
