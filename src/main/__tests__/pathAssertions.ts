import { expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

function sameFilesystemEntry(first: string, second: string): boolean {
  try {
    const firstStat = fs.statSync(first)
    const secondStat = fs.statSync(second)
    return firstStat.dev === secondStat.dev && firstStat.ino === secondStat.ino
  } catch {
    return false
  }
}

/** Compare paths without treating Windows short/long aliases as different files. */
export function expectSamePath(actual: string | null | undefined, expected: string): void {
  expect(actual).toBeTypeOf('string')
  if (typeof actual !== 'string') return

  if (process.platform !== 'win32') {
    expect(actual).toBe(expected)
    return
  }

  const actualResolved = path.resolve(actual)
  const expectedResolved = path.resolve(expected)
  if (sameFilesystemEntry(actualResolved, expectedResolved)) return

  expect(sameFilesystemEntry(path.dirname(actualResolved), path.dirname(expectedResolved))).toBe(true)
  expect(path.basename(actualResolved).toLowerCase()).toBe(path.basename(expectedResolved).toLowerCase())
}
