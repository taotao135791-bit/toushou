import { describe, expect, it } from 'vitest'
import { parseTodoInput } from './todoInput'

describe('parseTodoInput', () => {
  it('parses a todos array with status fields', () => {
    const items = parseTodoInput({
      todos: [
        { content: '拉取账户数据', status: 'completed' },
        { content: '诊断转化漏斗', status: 'in_progress' },
        { content: '输出优化清单', status: 'pending' }
      ]
    })
    expect(items).toEqual([
      { label: '拉取账户数据', state: 'done' },
      { label: '诊断转化漏斗', state: 'in_progress' },
      { label: '输出优化清单', state: 'pending' }
    ])
  })

  it('recognizes alternate containers, labels and state spellings', () => {
    expect(parseTodoInput({ items: [{ text: 'a', state: 'done' }] })).toEqual([
      { label: 'a', state: 'done' }
    ])
    expect(parseTodoInput({ list: [{ title: 'b', completed: true }] })).toEqual([
      { label: 'b', state: 'done' }
    ])
    expect(parseTodoInput({ plan: ['x'] })).toEqual([{ label: 'x', state: 'pending' }])
  })

  it('maps unknown status markers to pending', () => {
    expect(parseTodoInput({ todos: [{ content: 'x', status: 'weird' }] })).toEqual([
      { label: 'x', state: 'pending' }
    ])
    expect(parseTodoInput({ todos: [{ content: 'x' }] })).toEqual([
      { label: 'x', state: 'pending' }
    ])
  })

  it('returns null for shapes that are not a checklist', () => {
    expect(parseTodoInput(undefined)).toBeNull()
    expect(parseTodoInput('text')).toBeNull()
    expect(parseTodoInput({ todos: [] })).toBeNull()
    expect(parseTodoInput({ todos: [{ noLabel: true }] })).toBeNull()
    expect(parseTodoInput({ todos: [{ content: 'a' }, 42] })).toBeNull()
    expect(parseTodoInput({ other: [{ content: 'a' }] })).toBeNull()
  })

  it('accepts a bare array as the input itself', () => {
    expect(parseTodoInput(['a', { content: 'b', status: 'done' }])).toEqual([
      { label: 'a', state: 'pending' },
      { label: 'b', state: 'done' }
    ])
  })

  it('truncates oversized labels', () => {
    const items = parseTodoInput({ todos: [{ content: 'x'.repeat(400) }] })
    expect(items?.[0].label.length).toBe(300)
  })
})
