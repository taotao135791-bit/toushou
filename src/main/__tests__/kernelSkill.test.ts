import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readdirSync, unlinkSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// ensureKernelSkill only touches app.getPath('userData') — point it at a
// temp dir so cases run Electron-free.
const tmpRoot = mkdtempSync(path.join(os.tmpdir(), 'kernel-skill-'))
vi.mock('electron', () => ({ app: { getPath: () => tmpRoot } }))

import { ensureKernelSkill, KERNEL_SKILL_FILE_NAME, KERNEL_SKILL_MARKDOWN, KERNEL_SKILL_VERSION } from '../kernelSkill'

const file = () => path.join(tmpRoot, 'skills', KERNEL_SKILL_FILE_NAME)

beforeEach(() => {
  const dir = path.join(tmpRoot, 'skills')
  if (existsSync(dir)) {
    for (const f of readdirSync(dir)) unlinkSync(path.join(dir, f))
  }
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('ensureKernelSkill', () => {
  it('installs the playbook when missing', () => {
    expect(ensureKernelSkill().ok).toBe(true)
    const content = readFileSync(file(), 'utf-8')
    expect(content).toBe(KERNEL_SKILL_MARKDOWN)
    expect(content).toContain('toushou_task_create')
  })

  it('is idempotent and preserves same-version user edits', () => {
    expect(ensureKernelSkill().ok).toBe(true)
    const edited = KERNEL_SKILL_MARKDOWN.replace('第 0 步', '团队定制的第 0 步')
    writeFileSync(file(), edited, 'utf-8')
    expect(ensureKernelSkill().ok).toBe(true)
    // Same version on disk: the team's tuning stays.
    expect(readFileSync(file(), 'utf-8')).toBe(edited)
  })

  it('upgrades an outdated kernel version', () => {
    const outdated = KERNEL_SKILL_MARKDOWN.replace(
      `<!-- toushou:kernel-skill v${KERNEL_SKILL_VERSION} -->`,
      '<!-- toushou:kernel-skill v0 -->'
    )
    writeFileSync(file(), outdated, 'utf-8')
    expect(ensureKernelSkill().ok).toBe(true)
    expect(readFileSync(file(), 'utf-8')).toBe(KERNEL_SKILL_MARKDOWN)
  })

  it('a file without a version marker is treated as v0 and upgraded', () => {
    writeFileSync(file(), '# 手写的旧笔记\n', 'utf-8')
    expect(ensureKernelSkill().ok).toBe(true)
    expect(readFileSync(file(), 'utf-8')).toBe(KERNEL_SKILL_MARKDOWN)
  })
})
