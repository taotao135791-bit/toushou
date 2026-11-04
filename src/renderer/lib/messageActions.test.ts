import { describe, expect, it, vi } from 'vitest'
import { copyMessageText, messageActionText } from './messageActions'

describe('message action text', () => {
  it('copies the visible assistant text and preserves markdown and literal inline text', () => {
    const text = '## Summary\n**Ready**\n[[connect:mcp]]\nUse `[[connect:feishu]]` as an example.'
    expect(messageActionText({ role: 'assistant', content: text })).toBe('## Summary\n**Ready**\n\nUse `[[connect:feishu]]` as an example.')
  })

  it('keeps literal user input and does not mutate a stored message', () => {
    const message = { role: 'user', content: 'Explain this syntax:\n[[connect:mcp]]' }
    expect(messageActionText(message)).toBe(message.content)
    expect(message).toEqual({ role: 'user', content: 'Explain this syntax:\n[[connect:mcp]]' })
  })

  it('does not turn a UI-only guide into savable board text', () => {
    expect(messageActionText({ role: 'assistant', content: '[[connect:feishu]]' }).trim()).toBe('')
  })
})

describe('clipboard acknowledgement', () => {
  it('acknowledges only after the clipboard write resolves', async () => {
    let resolveWrite!: () => void
    let settled = false
    const write = vi.fn(() => new Promise<void>(resolve => { resolveWrite = resolve }))
    const result = copyMessageText('**Synthetic summary**', write).then(ok => { settled = true; return ok })
    await Promise.resolve()
    expect(write).toHaveBeenCalledWith('**Synthetic summary**')
    expect(settled).toBe(false)
    resolveWrite()
    expect(await result).toBe(true)
  })

  it('reports failure when writing rejects or throws, allowing a later retry', async () => {
    const write = vi.fn().mockRejectedValueOnce(new Error('denied')).mockResolvedValueOnce(undefined)
    expect(await copyMessageText('Synthetic text', write)).toBe(false)
    expect(await copyMessageText('Synthetic text', write)).toBe(true)
    expect(await copyMessageText('Synthetic text', () => { throw new Error('unavailable') })).toBe(false)
  })
})
