import { useEffect, useState } from 'react'
import { ChevronRight, ChevronDown, Folder, File, Loader2 } from 'lucide-react'
import { useShallow } from 'zustand/react/shallow'
import { useAppStore } from '../store'
import { useT } from '../i18n'

interface TreeNode {
  name: string
  path: string
  isDirectory: boolean
  children?: TreeNode[]
  expanded: boolean
  loading?: boolean
}

const FILE_TREE_TIMEOUT_MS = 8_000

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('file-tree-timeout')), timeoutMs)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error) => {
        clearTimeout(timer)
        reject(error)
      }
    )
  })
}

/** Build a complete, expandable tree from the trusted flat project manifest. */
function buildProjectTree(files: string[], rootName: string): TreeNode {
  const root: TreeNode = {
    name: rootName,
    path: '',
    isDirectory: true,
    children: [],
    expanded: true
  }

  for (const rawPath of files) {
    const parts = rawPath.replace(/\\/g, '/').split('/').filter(Boolean)
    if (
      parts.length === 0 ||
      parts.some((part) => part.startsWith('.') || part === 'node_modules')
    ) {
      continue
    }

    let children = root.children!
    let parentPath = ''
    parts.forEach((part, index) => {
      const nodePath = parentPath ? `${parentPath}/${part}` : part
      let node = children.find((candidate) => candidate.path === nodePath)
      if (!node) {
        const isDirectory = index < parts.length - 1
        node = {
          name: part,
          path: nodePath,
          isDirectory,
          ...(isDirectory ? { children: [] } : {}),
          expanded: false
        }
        children.push(node)
      }
      if (node.isDirectory) children = node.children!
      parentPath = nodePath
    })
  }

  const sortTree = (nodes: TreeNode[]) => {
    nodes.sort((a, b) => {
      if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1
      return a.name.localeCompare(b.name)
    })
    for (const node of nodes) {
      if (node.children) sortTree(node.children)
    }
  }
  sortTree(root.children!)
  return root
}

export default function FileTree() {
  const { currentWorkspace, selectedFile, setSelectedFile, setActiveRightTab } = useAppStore(
    useShallow((s) => ({
      currentWorkspace: s.currentWorkspace,
      selectedFile: s.selectedFile,
      setSelectedFile: s.setSelectedFile,
      setActiveRightTab: s.setActiveRightTab
    }))
  )
  const [tree, setTree] = useState<TreeNode[]>([])
  const [loadState, setLoadState] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle')
  const [reloadToken, setReloadToken] = useState(0)
  const t = useT()

  useEffect(() => {
    if (!currentWorkspace) {
      setTree([])
      setLoadState('idle')
      return
    }
    const workspace = currentWorkspace
    setTree([])
    setLoadState('loading')
    void withTimeout(window.electronAPI.listProjectFiles(workspace.id), FILE_TREE_TIMEOUT_MS)
      .then((files) => {
        setTree([
          buildProjectTree(
            files,
            workspace.displayPath.split('/').pop() || workspace.displayPath
          )
        ])
        setLoadState('ready')
      })
      .catch(() => {
        setTree([])
        setLoadState('error')
      })
  }, [currentWorkspace?.id, reloadToken])

  const toggleNode = (node: TreeNode, parentList: TreeNode[], setParentList: (list: TreeNode[]) => void) => {
    if (!node.isDirectory) {
      if (!currentWorkspace) return
      setSelectedFile(node.path)
      setActiveRightTab('preview')
      return
    }
    setParentList(parentList.map((n) =>
      n.path === node.path ? { ...n, expanded: !n.expanded } : n
    ))
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
      {loadState === 'loading' ? (
        <div className="flex items-center gap-1.5 px-2 py-1 text-xs text-cream-faint">
          <Loader2 size={11} className="animate-spin" />
          {t('panel.loading')}
        </div>
      ) : loadState === 'error' ? (
        <div className="flex flex-col items-start gap-2 px-2 py-2 text-xs text-cream-faint">
          <span>{t('panel.loadFailed')}</span>
          <button
            type="button"
            onClick={() => setReloadToken((value) => value + 1)}
            className="rounded-md border border-line px-2.5 py-1 text-[11px] text-cream-dim transition-colors hover:border-line-strong hover:text-cream"
          >
            {t('panel.retry')}
          </button>
        </div>
      ) : (
        tree.map((node) => renderNode(node, tree, setTree))
      )}
    </div>
  )
}
