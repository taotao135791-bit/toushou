import { describe, expect, it } from 'vitest'
import { exportFilename } from './exportFilename'

describe('exportFilename', () => {
  it('keeps only the filename for POSIX and Windows paths', () => {
    expect(exportFilename('/Users/test/Downloads/omp-session.html')).toBe('omp-session.html')
    expect(exportFilename('C:\\Users\\test\\Downloads\\omp-session.html')).toBe('omp-session.html')
  })

  it('falls back to the original value when no filename can be separated', () => {
    expect(exportFilename('omp-session.html')).toBe('omp-session.html')
    expect(exportFilename('')).toBe('')
  })
})

