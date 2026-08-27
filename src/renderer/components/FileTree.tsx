import { useEffect, useRef, useState } from 'react'
import { ChevronRight, ChevronDown, Folder, File, Loader2 } from 'lucide-react'
import { useAppStore } from '../store'
import { useT } from '../i18n'
import { WorkspaceRequestFence } from '../lib/workspaceRequest'

interface TreeNode {
  name: string
  path: string
  isDirectory: boolean
  children?: TreeNode[]
  expanded: boolean
  loading?: boolean
}

export default function FileTree() {
  const { currentWorkspace, selectedFile, setSelectedFile, setActiveRightTab } = useAppStore()
  const [tree, setTree] = useState<TreeNode[]>([])
  const [loading, setLoading] = useState(false)
  const requestFence = useRef(new WorkspaceRequestFence()).current
  const treeGeneration = useRef(0)
  const t = useT()

  // Update synchronously with render, rather than waiting for an effect: an
  // older IPC completion can otherwise win in the short gap after a workspace
  // switch has rendered but before its effects run.
  requestFence.setWorkspace(currentWorkspace?.id ?? null)

  useEffect(() => {
    const generation = ++treeGeneration.current
    if (!currentWorkspace) {
      setTree([])
      setLoading(false)
      return
    }
    const workspace = currentWorkspace
    const request = requestFence.begin(workspace.id, 'root')
    setTree([])
    setLoading(true)
    void loadDir(workspace.id, '')
      .then((children) => {
        if (!requestFence.isCurrent(request) || treeGeneration.current !== generation) return
        setTree([
          {
            name: workspace.displayPath.split('/').pop() || workspace.displayPath,
            path: '',
            isDirectory: true,
            children,
            expanded: true
          }
        ])
        setLoading(false)
      })
      .catch(() => {
        if (!requestFence.isCurrent(request) || treeGeneration.current !== generation) return
        setTree([])
        setLoading(false)
      })
  }, [currentWorkspace])

  const loadDir = async (grantId: string, relativePath: string): Promise<TreeNode[]> => {
    const entries = await window.electronAPI.listDir(grantId, relativePath || undefined)
    return entries
      .filter((e) => !e.name.startsWith('.') && e.name !== 'node_modules')
      .sort((a, b) => (a.isDirectory === b.isDirectory ? a.name.localeCompare(b.name) : a.isDirectory ? -1 : 1))
      .map((e) => ({
        name: e.name,
        path: e.path,
        isDirectory: e.isDirectory,
        expanded: false
      }))
  }

  const toggleNode = async (node: TreeNode, parentList: TreeNode[], setParentList: (list: TreeNode[]) => void) => {
    if (!node.isDirectory) {
      if (!currentWorkspace) return
      setSelectedFile(node.path)
      setActiveRightTab('preview')
      return
    }

    if (node.loading) {
      // IPC cannot be aborted, but dropping its token makes a second click a
      // real cancellation instead of letting the late response reopen it.
      requestFence.invalidate(`tree:${node.path}`)
      setParentList(parentList.map((n) => (n.path === node.path ? { ...n, loading: false } : n)))
      return
    }

    if (node.expanded) {
      requestFence.invalidate(`tree:${node.path}`)
      const updated = parentList.map((n) => (n.path === node.path ? { ...n, expanded: false, children: undefined } : n))
      setParentList(updated)
      return
    }

    if (!currentWorkspace) return
    const workspace = currentWorkspace
    const generation = treeGeneration.current
    const request = requestFence.begin(workspace.id, `tree:${node.path}`)
    setParentList(parentList.map((n) => (n.path === node.path ? { ...n, loading: true } : n)))
    try {
      const children = await loadDir(workspace.id, node.path)
      if (!requestFence.isCurrent(request) || treeGeneration.current !== generation) return
      const updated = parentList.map((n) =>
        n.path === node.path ? { ...n, expanded: true, children, loading: false } : n
      )
      setParentList(updated)
    } catch {
      if (!requestFence.isCurrent(request) || treeGeneration.current !== generation) return
      setParentList(parentList.map((n) => (n.path === node.path ? { ...n, loading: false } : n)))
    }
  }

  const renderNode = (
    node: TreeNode,
    parentList: TreeNode[],
    setParentList: (list: TreeNode[]) => void,
    depth = 0
  ) => {
    const isSelected = selectedFile === node.path

    return (
      <div key={node.path}>
        <div
          onClick={() => toggleNode(node, parentList, setParentList)}
          className={`flex h-7 cursor-pointer items-center gap-1.5 rounded-md pr-2 font-mono text-[12px] transition ${
            isSelected ? 'bg-accent/10 text-accent' : 'text-cream-dim hover:bg-overlay hover:text-cream'
          }`}
          style={{ paddingLeft: `${depth * 12 + 8}px` }}
        >
          {node.isDirectory ? (
            node.expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />
          ) : (
            <span className="w-3" />
          )}
          {node.isDirectory ? (
            <Folder size={13} className="text-accent/70" />
          ) : (
            <File size={13} className="text-cream-faint" />
          )}
          <span className="truncate">{node.name}</span>
          {node.loading && (
            <Loader2 size={11} className="ml-auto shrink-0 animate-spin text-cream-faint" />
          )}
        </div>
        {node.isDirectory && node.expanded && node.children && node.children.length === 0 && (
          <div
            className="flex h-6 items-center text-[11px] text-cream-faint"
            style={{ paddingLeft: `${(depth + 1) * 12 + 8}px` }}
          >
            {t('panel.emptyOrInaccessible')}
          </div>
        )}
        {node.isDirectory && node.expanded && node.children && (
          <div>
            {node.children.map((child) =>
              renderNode(child, node.children!, (newChildren) => {
                const updated = parentList.map((n) =>
                  n.path === node.path ? { ...n, children: newChildren } : n
                )
                setParentList(updated)
              }, depth + 1)
            )}
          </div>
        )}
      </div>
    )
  }

  if (!currentWorkspace) {
    return (
      <div className="p-4 text-xs text-cream-faint">{t('panel.selectProject')}</div>
    )
  }

  return (
    <div className="px-1.5 py-2">
      {loading ? (
        <div className="flex items-center gap-1.5 px-2 py-1 text-xs text-cream-faint">
          <Loader2 size={11} className="animate-spin" />
          {t('panel.loading')}
        </div>
      ) : (
        tree.map((node) => renderNode(node, tree, setTree))
      )}
    </div>
  )
}
