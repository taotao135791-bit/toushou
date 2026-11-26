import { expect, it } from 'vitest'
import { composerHistoryCommand, hasPrimaryModifier, platformFromBrowser } from './platformShortcut'
import { fileManagerRevealKey, modShortcut, translate } from '../i18n'

it.each(['darwin', 'win32', 'linux'])('uses the primary shortcut modifier on %s', platform => {
  expect(hasPrimaryModifier({ metaKey: true, ctrlKey: false }, platform)).toBe(platform === 'darwin')
  expect(hasPrimaryModifier({ metaKey: false, ctrlKey: true }, platform)).toBe(platform !== 'darwin')
  expect(hasPrimaryModifier({ metaKey: true, ctrlKey: true }, platform)).toBe(false)
})

it.each([
  ['MacIntel', 'darwin'],
  ['Win32', 'win32'],
  ['Mozilla/5.0 (Windows NT 10.0; Win64; x64)', 'win32'],
  ['Linux x86_64', 'linux']
])('falls back to the platform in browser previews for %s', (identifier, platform) => {
  expect(platformFromBrowser(identifier)).toBe(platform)
})

it('uses Windows and macOS conventions for composer history commands', () => {
  const ctrl = { ctrlKey: true, metaKey: false, altKey: false, shiftKey: false }
  const command = { ...ctrl, ctrlKey: false, metaKey: true }
  expect(composerHistoryCommand({ ...ctrl, key: 'z' }, 'win32')).toBe('undo')
  expect(composerHistoryCommand({ ...ctrl, key: 'y' }, 'win32')).toBe('redo')
  expect(composerHistoryCommand({ ...ctrl, shiftKey: true, key: 'Z' }, 'win32')).toBe('redo')
  expect(composerHistoryCommand({ ...command, key: 'z' }, 'darwin')).toBe('undo')
  expect(composerHistoryCommand({ ...command, shiftKey: true, key: 'Z' }, 'darwin')).toBe('redo')
  expect(composerHistoryCommand({ ...command, key: 'y' }, 'darwin')).toBeUndefined()
  expect(composerHistoryCommand({ ...ctrl, altKey: true, key: 'y' }, 'win32')).toBeUndefined()
})

it('uses matching shortcut hints and file managers on each desktop platform', () => {
  expect(modShortcut('N', 'darwin')).toBe('⌘N')
  expect(modShortcut('N', 'win32')).toBe('Ctrl+N')
  expect(translate('zh', fileManagerRevealKey('darwin'))).toContain('Finder')
  expect(translate('zh', fileManagerRevealKey('win32'))).toContain('文件资源管理器')
  expect(translate('en', fileManagerRevealKey('linux'))).toBe('Show in file manager')
})
