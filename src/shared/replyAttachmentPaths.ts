import { chatAttachment } from './chatAttachment'

interface MarkdownNode {
  type: string
  value?: string
  alt?: string | null
  url?: string
  identifier?: string
  children?: MarkdownNode[]
  position?: { start: { offset?: number }; end?: { offset?: number } }
}

interface Candidate { raw: string; offset: number; linked: boolean }
const MAX_SOURCE = 512_000
const absolute = /^(?:\/(?!\/)|[a-z]:[\\/]|~[\\/]|file:\/\/)/i
const folderCue = /(?:目录|文件夹|文件都在|材料都在|归档到|保存在|保存至|保存到|输出至|输出到|folder|directory|files? (?:are )?in|saved (?:in|to)|outputs? (?:are )?in)[\s：:为是在*_\x60[(\p{Extended_Pictographic}\p{Emoji_Modifier}\uFE0E\uFE0F\u200D]*$/iu
const leadingPathDecoration = /^[\p{Extended_Pictographic}\p{Emoji_Modifier}\uFE0E\uFE0F\u200D]+\s*/u

export function stripLeadingPathDecoration(value: string): string {
  const path = value.replace(leadingPathDecoration, '')
  return absolute.test(path) ? path : value
}

export function isInlineFilePath(value: string): boolean {
  return pictureRange(value) || /^(?:[./~][\\/]|\/|[a-z]:[\\/]|sandbox:|file:)/i.test(value)
    || /^[\p{L}\p{N}_.()%-]+(?:[\\/][\p{L}\p{N}_.()%-]+)*$/u.test(value)
    || /^[\p{L}\p{N}_.()%-]+[\\/][\p{L}\p{N}_.()% \\/-]+$/u.test(value)
}

// Bare text is recognized only at word boundaries. Quoted or linked paths
// with spaces are handled by Markdown itself.
export function* plainPathTokens(text: string) {
  for (const match of text.matchAll(/[^\s\x60<>()\[\]{},;!，。！？；：“”‘’、【】（）「」|*]+/gu)) {
    const path = stripLeadingPathDecoration(match[0])
    const raw = path.replace(/[.,;!]+$/, '')
    if (raw && (absolute.test(raw) || raw.includes('.'))) yield { raw, offset: match.index + match[0].length - path.length }
  }
}

function folderPath(raw: string, explicit: boolean, linked: boolean): string | undefined {
  if (!absolute.test(raw) || (!explicit && !linked) || chatAttachment(raw)) return
  // The file parser checks URL authority, traversal, control characters and decoding.
  const prefix = raw.replace(/[\\/]+$/, '')
  if (!prefix || /^[a-z]:$/i.test(prefix)) return
  const probe = chatAttachment(prefix + '/__folder_probe__.txt')
  if (!probe || probe.remote) return
  const folder = probe.target.slice(0, -'/__folder_probe__.txt'.length)
  // A lone root-relative slug can be an ordinary web route. Require an
  // explicit cue for that shape and for paths whose last segment has a suffix.
  const singleRouteSegment = !/^file:\/\//i.test(raw) && /^\/[^/]+$/.test(folder)
  if (!explicit && (singleRouteSegment || /[?#]/.test(raw) || /\.[^\\/]+$/.test(folder))) return
  return folder
}

function key(path: string): string {
  return /^[a-z]:[\\/]/i.test(path) ? path.replace(/\\/g, '/').toLowerCase() : path
}

function pictureRange(raw: string): boolean {
  return /^(?:fig(?:ure)?|图|图片)[_-]?\d+\s*[-–—~～至]\s*(?:fig(?:ure)?|图|图片)?[_-]?\d+\.(?:png|jpe?g|webp|gif|svg)$/iu.test(raw)
}

function displayLabel(node: MarkdownNode): string {
  return node.value ?? node.alt ?? node.children?.map(displayLabel).join('') ?? ''
}

export function collectReplyAttachmentPaths(tree: MarkdownNode, source: string) {
  const folders = new Set<string>()
  const files = new Set<string>()
  const folderAt = new Map<number, string>()
  const byBasename = new Map<string, string | null>()
  const declarations: Array<{ offset: number; folder: string; scopeEnd: number; lineStart: number }> = []
  const declaredFolders = new Set<string>()
  const candidates: Candidate[] = []
  const definitions = new Map<string, string>()
  let scopeEnd = 0

  function register(raw: string, offset: number, kind: 'text' | 'link' | 'image' = 'text', folderLabel = false) {
    const explicit = folderLabel || /[\\/]$/.test(raw) || folderCue.test(source.slice(Math.max(0, offset - 80), offset))
    const folder = folderPath(raw, explicit, kind === 'link')
    if (folder) {
      folders.add(folder)
      folderAt.set(offset, folder)
      // A linked directory is clickable on its own. Only a delivery cue
      // makes it the base path for other file references in this reply.
      if (explicit) {
        declaredFolders.add(folder)
        declarations.push({ offset, folder, scopeEnd, lineStart: source.lastIndexOf('\n', offset) + 1 })
      }
      return
    }
    const linked = kind !== 'text'
    const file = chatAttachment(raw)
    if (!file || file.remote || file.sandbox || !linked && pictureRange(raw)) return
    candidates.push({ raw, offset, linked })
    if (absolute.test(file.target)) {
      const previous = byBasename.get(file.name)
      if (previous === undefined) byBasename.set(file.name, raw)
      else if (previous !== null && previous !== raw && key(chatAttachment(previous)!.target) !== key(file.target)) byBasename.set(file.name, null)
    }
  }

  function visit(node: MarkdownNode) {
    const offset = node.position?.start.offset ?? 0
    switch (node.type) {
      case 'code': case 'html': case 'definition': return
      case 'inlineCode': {
        const value = stripLeadingPathDecoration(node.value?.trim() ?? '')
        if (value && isInlineFilePath(value)) register(value, offset)
        return
      }
      case 'link': case 'image': case 'linkReference': case 'imageReference': {
        const raw = node.url ?? definitions.get(node.identifier ?? '')
        const kind = node.type === 'link' || node.type === 'linkReference' ? 'link' : 'image'
        if (raw) register(raw, offset, kind, /(?:目录|文件夹|\b(?:folder|directory)\b)/iu.test(displayLabel(node)))
        return
      }
      case 'text':
        for (const token of plainPathTokens(node.value ?? '')) register(token.raw, offset + token.offset)
        return
      default: node.children?.forEach(visit)
    }
  }

  function indexDefinitions(node: MarkdownNode) {
    if (node.type === 'definition' && node.identifier && node.url && !definitions.has(node.identifier)) definitions.set(node.identifier, node.url)
    else node.children?.forEach(indexDefinitions)
  }
  if (source.length <= MAX_SOURCE && /[./\\]/.test(source)) {
    indexDefinitions(tree)
    const blocks = tree.children ?? []
    for (const [index, block] of blocks.entries()) {
      // An adjacent paragraph, list or table may enumerate a folder's files.
      // Separately headed sections never inherit a preceding folder.
      const next = blocks[index + 1]
      const end = next && ['paragraph', 'list', 'table'].includes(next.type) ? next : block
      scopeEnd = end.position?.end?.offset ?? source.length
      visit(block)
    }
  }
  const singleFolder = declaredFolders.size === 1 ? declarations[0].folder : undefined

  function contextualFolder(offset: number): string | undefined {
    if (singleFolder || !declarations.length) return singleFolder
    // When several folders are named, bind only the immediately adjacent delivery block.
    let lo = 0, hi = declarations.length
    while (lo < hi) {
      const mid = (lo + hi) >>> 1
      if (declarations[mid].offset <= offset) lo = mid + 1
      else hi = mid
    }
    const here = declarations[lo - 1]
    if (!here || offset > here.scopeEnd) return
    const prev = declarations[lo - 2]
    if (prev && prev.folder !== here.folder && prev.offset >= here.lineStart) return
    return here.folder
  }

  function resolve(raw: string, offset: number, linked = false): string | undefined {
    const file = chatAttachment(raw)
    if (!file) return
    if (absolute.test(file.target) || file.remote || file.sandbox) return raw
    if (!linked && pictureRange(raw)) return
    const folder = contextualFolder(offset)
    if (folder) {
      // Preserve encoded filename characters for the host's single decode.
      const slash = /^[a-z]:\\/i.test(folder) ? '\\' : '/'
      const encodedFolder = folder.replace(/%/g, '%25')
      const target = encodedFolder.replace(/[\\/]+$/, '') + slash + raw.replace(/^(?:\.[\\/])+/, '')
      return chatAttachment(target) ? target : undefined
    }
    if (!/[\\/]/.test(raw) && byBasename.has(file.name)) return byBasename.get(file.name) ?? undefined
    return declaredFolders.size > 1 ? undefined : raw
  }

  function rangeFolder(raw: string, offset: number): string | undefined {
    return pictureRange(raw) ? contextualFolder(offset) : undefined
  }

  for (const { raw, offset, linked } of candidates) {
    const target = resolve(raw, offset, linked)
    const file = target && chatAttachment(target)
    if (file && !file.remote && !file.sandbox) files.add(file.target)
  }
  return { files, folders, folderAt, resolve, rangeFolder }
}

/** Main re-derives paths from the selected transcript, on demand after a user gesture. */
export async function replyAttachmentPaths(content: string) {
  if (!content || content.length > MAX_SOURCE || !/[./\\]/.test(content)) return { files: new Set<string>(), folders: new Set<string>() }
  const { fromMarkdown } = await import('mdast-util-from-markdown')
  return collectReplyAttachmentPaths(fromMarkdown(content), content)
}
