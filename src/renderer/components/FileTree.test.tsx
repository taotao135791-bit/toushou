import { describe, expect, it } from 'vitest'
import { buildProjectTree } from './FileTree'

describe('buildProjectTree', () => {
  it('reuses nested nodes, filters hidden paths, and sorts directories before files', () => {
    const tree = buildProjectTree([
      'src/z.ts',
      'src/a.ts',
      'src/deep/index.ts',
      'package.json',
      '.hidden/secret.txt',
      'node_modules/pkg/index.js'
    ], 'workspace')

    expect(tree.children?.map((node) => node.name)).toEqual(['src', 'package.json'])
    const src = tree.children?.[0]
    expect(src?.isDirectory).toBe(true)
    expect(src?.children?.map((node) => node.name)).toEqual(['deep', 'a.ts', 'z.ts'])
    expect(src?.children?.[0].children?.map((node) => node.name)).toEqual(['index.ts'])
  })
})
