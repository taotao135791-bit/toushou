import { describe, expect, it } from 'vitest'
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ProjectChildTracker } from './projectChildTracker'

describe('project child lifecycle', () => {
  it('keeps an automatically retired child busy until the actual exit', () => {
    const tracker = new ProjectChildTracker()
    const child = Object.assign(new EventEmitter(), { pid: 123 })
    const retire = tracker.watch('session', '/synthetic/project', child)
    retire() // handshake/first-frame failure can remove the session immediately
    expect(tracker.hasRetiringOverlap('/synthetic/project')).toBe(true)
    child.emit('error', new Error('synthetic kill failure'))
    expect(tracker.hasRetiringOverlap('/synthetic/project')).toBe(true)
    child.emit('exit')
    expect(tracker.hasRetiringOverlap('/synthetic/project')).toBe(false)
  })
  it('recognizes a retiring child spawned through a filesystem alias', () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'child-tracker-test-'))
    try {
      const project = path.join(base, 'project'); const alias = path.join(base, 'alias')
      fs.mkdirSync(project); fs.symlinkSync(project, alias, process.platform === 'win32' ? 'junction' : 'dir')
      const child = Object.assign(new EventEmitter(), {pid: 125})
      const tracker = new ProjectChildTracker(); const retire = tracker.watch('alias', alias, child)
      retire()
      expect(tracker.hasRetiringOverlap(fs.realpathSync.native(project))).toBe(true)
      child.emit('exit')
    } finally { fs.rmSync(base, {recursive:true, force:true}) }
  })
  it('does not retain an already exited or failed-to-spawn child', () => {
    const tracker = new ProjectChildTracker()
    const exited = Object.assign(new EventEmitter(), { pid: 124 })
    const retired = tracker.watch('exited', '/synthetic/project', exited)
    exited.emit('exit'); retired()
    const failed = new EventEmitter()
    const retireFailed = tracker.watch('failed', '/synthetic/project', failed)
    failed.emit('error', new Error('synthetic spawn failure')); retireFailed()
    expect(tracker.hasRetiringOverlap('/synthetic/project')).toBe(false)
  })
})
