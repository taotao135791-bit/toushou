import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { FsGuard } from '../fsGuard'

/**
 * Real-temp-dir, real-symlink tests — no path mocking. os.tmpdir() on macOS
 * is itself behind a symlink (/var -> /private/var), so every test also
 * exercises the root-canonicalization path implicitly.
 */
describe('FsGuard', () => {
  let base: string
  let root: string // registered project dir: <base>/project
  let outside: string // unregistered dir next to it: <base>/outside
  let guard: FsGuard

  beforeEach(() => {
    base = fs.mkdtempSync(path.join(os.tmpdir(), 'fsguard-'))
    root = path.join(base, 'project')
    outside = path.join(base, 'outside')
    fs.mkdirSync(root)
    fs.mkdirSync(outside)
    fs.mkdirSync(path.join(root, 'sub'))
    fs.writeFileSync(path.join(root, 'file.txt'), 'hello')
    fs.writeFileSync(path.join(root, 'sub', 'inner.txt'), 'inner')
    fs.writeFileSync(path.join(outside, 'secret.txt'), 'secret')
    guard = new FsGuard()
    guard.addRoot(root)
  })

  afterEach(() => {
    fs.rmSync(base, { recursive: true, force: true })
  })

  it('allows existing files under a registered root', () => {
    expect(guard.isAllowed(root)).toBe(true)
    expect(guard.isAllowed(path.join(root, 'file.txt'))).toBe(true)
    expect(guard.isAllowed(path.join(root, 'sub', 'inner.txt'))).toBe(true)
  })

  it('denies absolute paths outside all roots', () => {
    expect(guard.isAllowed(path.join(outside, 'secret.txt'))).toBe(false)
    expect(guard.isAllowed('/etc/passwd')).toBe(false)
  })

  it('denies traversal outside the root', () => {
    expect(guard.isAllowed(path.join(root, '..', 'outside', 'secret.txt'))).toBe(false)
  })

  it('allows traversal that resolves back inside the root', () => {
    expect(guard.isAllowed(path.join(root, 'sub', '..', 'file.txt'))).toBe(true)
  })

  it('denies sibling directories that share a name prefix', () => {
    const evil = path.join(base, 'project-evil')
    fs.mkdirSync(evil)
    fs.writeFileSync(path.join(evil, 'x.txt'), 'x')
    expect(guard.isAllowed(path.join(evil, 'x.txt'))).toBe(false)
  })

  it('denies a file symlink escaping the root', () => {
    const link = path.join(root, 'link.txt')
    fs.symlinkSync(path.join(outside, 'secret.txt'), link)
    expect(guard.isAllowed(link)).toBe(false)
  })

  it('denies a directory symlink escaping the root', () => {
    const link = path.join(root, 'linkdir')
    fs.symlinkSync(outside, link)
    expect(guard.isAllowed(path.join(link, 'secret.txt'))).toBe(false)
    expect(guard.isAllowed(link)).toBe(false)
  })

  it('denies a nested symlink chain escaping the root', () => {
    const inner = path.join(root, 'chain-inner')
    const outer = path.join(root, 'chain-outer')
    fs.symlinkSync(outside, inner)
    fs.symlinkSync(inner, outer)
    expect(guard.isAllowed(path.join(outer, 'secret.txt'))).toBe(false)

    const fileA = path.join(root, 'a.txt')
    const fileB = path.join(root, 'b.txt')
    fs.symlinkSync(path.join(outside, 'secret.txt'), fileB)
    fs.symlinkSync(fileB, fileA)
    expect(guard.isAllowed(fileA)).toBe(false)
  })

  it('denies broken symlinks without crashing', () => {
    const brokenInside = path.join(root, 'broken-inside')
    fs.symlinkSync(path.join(root, 'does-not-exist.txt'), brokenInside)
    expect(guard.isAllowed(brokenInside)).toBe(false)

    const brokenOutside = path.join(root, 'broken-outside')
    fs.symlinkSync(path.join(outside, 'missing.txt'), brokenOutside)
    expect(guard.isAllowed(brokenOutside)).toBe(false)
  })

  it('denies nonexistent paths on read, even inside the root', () => {
    expect(guard.isAllowed(path.join(root, 'nope.txt'))).toBe(false)
  })

  it('allows symlinks whose targets stay inside the project', () => {
    const dirLink = path.join(root, 'sublink')
    fs.symlinkSync(path.join(root, 'sub'), dirLink)
    expect(guard.isAllowed(path.join(dirLink, 'inner.txt'))).toBe(true)

    const fileLink = path.join(root, 'inner-link.txt')
    fs.symlinkSync(path.join(root, 'sub', 'inner.txt'), fileLink)
    expect(guard.isAllowed(fileLink)).toBe(true)
  })

  it('supports a root that is itself a symlink', () => {
    const real = path.join(base, 'realproj')
    fs.mkdirSync(real)
    fs.writeFileSync(path.join(real, 'file.txt'), 'real')
    const rootLink = path.join(base, 'rootlink')
    fs.symlinkSync(real, rootLink)

    const g = new FsGuard()
    g.addRoot(rootLink)
    expect(g.isAllowed(path.join(rootLink, 'file.txt'))).toBe(true)

    // An escape from inside the symlinked root is still denied.
    fs.symlinkSync(outside, path.join(real, 'escape'))
    expect(g.isAllowed(path.join(rootLink, 'escape', 'secret.txt'))).toBe(false)
  })

  it('supports multiple roots and removal', () => {
    const other = path.join(base, 'other')
    fs.mkdirSync(other)
    fs.writeFileSync(path.join(other, 'f.txt'), 'f')
    guard.addRoot(other)
    expect(guard.isAllowed(path.join(root, 'file.txt'))).toBe(true)
    expect(guard.isAllowed(path.join(other, 'f.txt'))).toBe(true)
    guard.removeRoot(root)
    expect(guard.isAllowed(path.join(root, 'file.txt'))).toBe(false)
    expect(guard.isAllowed(path.join(other, 'f.txt'))).toBe(true)
  })

  it('normalizes non-resolved roots', () => {
    const g = new FsGuard()
    g.addRoot(path.join(root, 'sub', '..', 'sub', '.'))
    expect(g.isAllowed(path.join(root, 'sub', 'inner.txt'))).toBe(true)
    expect(g.isAllowed(path.join(root, 'file.txt'))).toBe(false)
  })

  it('denies everything without registered roots', () => {
    const g = new FsGuard()
    expect(g.isAllowed(path.join(root, 'file.txt'))).toBe(false)
  })
})
