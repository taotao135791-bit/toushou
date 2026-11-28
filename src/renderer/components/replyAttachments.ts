import type { ExtraProps } from 'react-markdown'
import { chatAttachment } from '@shared/chatAttachment'
import { collectReplyAttachmentPaths, isInlineFilePath, plainPathTokens, stripLeadingPathDecoration } from '@shared/replyAttachmentPaths'

type Element = NonNullable<ExtraProps['node']>
type Child = Element['children'][number]
interface Reference { target: string; label: string; anchor: string; folder?: boolean }

type PathIndex = ReturnType<typeof collectReplyAttachmentPaths>
interface ParsedFile { data: Record<string, unknown>; value: unknown }

/** Use the same Markdown tree already parsed for display. */
export function indexReplyAttachments() {
  return (tree: Parameters<typeof collectReplyAttachmentPaths>[0], file: ParsedFile): void => {
    file.data.replyPaths = collectReplyAttachmentPaths(tree, String(file.value))
  }
}

function textLabel(child: Child): string {
  if (child.type === 'text') return child.value
  if (child.type !== 'element') return ''
  if (child.tagName === 'img') return String(child.properties.alt ?? '')
  return child.children.map(textLabel).join('')
}

function isWebPreview(child: Child): boolean {
  if (child.type !== 'element') return false
  if (child.tagName !== 'img') return child.children.some(isWebPreview)
  const source = String(child.properties.src ?? '')
  if (!/^https?:\/\//i.test(source)) return false
  const file = chatAttachment(source)
  return !file || file.kind === 'photo'
}

function referenceElement(tagName: string, target: string, label: string): Element {
  return { type: 'element', tagName, properties: { target, label }, children: [] }
}

/** Transform the parsed reply once, after reference links and GFM have been resolved. */
export function groupReplyAttachments(idPrefix: string) {
  return (tree: { children: Child[] }, parsed: ParsedFile): void => {
    const paths = parsed.data.replyPaths as PathIndex | undefined
    const files = new Map<string, Reference>()

    function mention(raw: string, offset: number, label: string, source: 'text' | 'code' | 'link', thumbnail?: Child[]): Element | undefined {
      const linked = source === 'link'
      // 文件夹判定只信共享层收集器的 folderAt（它在源头按路径形状/线索分类，
      // 有测试覆盖）；渲染层不再自行猜测"无扩展名=文件夹"——猜测会把
      // Makefile 这类无扩展名文件变成打不开的文件夹卡片。
      const folder = paths?.folderAt.get(offset)
      if (folder) return referenceElement('reply-attachment-folder', folder, label || raw)
      const group = !linked && paths?.rangeFolder(raw, offset)
      if (group) {
        const key = 'folder:' + group
        if (!files.has(key)) files.set(key, { target: group, label: '', folder: true, anchor: idPrefix + '-' + files.size })
        return referenceElement('reply-attachment-folder', group, label || raw)
      }
      const target = paths ? paths.resolve(raw, offset, linked) : raw
      const file = target && chatAttachment(target)
      if (!target || !file) return
      // A standalone word in ordinary prose needs an explicit or contextual location.
      if (source === 'text' && target === raw && !/^(?:\/|[a-z]:[\\/]|~[\\/])/i.test(file.target)) return
      let key = file.target
      if (file.remote) key = new URL(key).href
      else if (/^[a-z]:[\\/]/i.test(key)) key = key.replace(/\\/g, '/').toLowerCase()
      else key = key.replace(/^(?:\.\/)+/, '')
      const card = files.get(key) ?? { target, label: label || file.name, anchor: idPrefix + '-' + files.size }
      files.set(key, card)
      const element = referenceElement('reply-attachment-mention', target, label || file.name)
      element.properties.fallbackHref = '#' + card.anchor
      if (thumbnail) element.children = thumbnail
      return element
    }

    function visit(children: Child[]): void {
      for (let index = 0; index < children.length; index++) {
        const child = children[index]
        const start = child.position?.start.offset ?? 0
        if (child.type === 'text' && paths && (paths.files.size || paths.folders.size)) {
          let end = 0
          const pieces: Child[] = []
          for (const { raw, offset } of plainPathTokens(child.value)) {
            const element = mention(raw, start + offset, raw, 'text')
            if (!element) continue
            if (offset > end) pieces.push({ type: 'text', value: child.value.slice(end, offset) })
            pieces.push(element)
            end = offset + raw.length
          }
          if (pieces.length) {
            if (end < child.value.length) pieces.push({ type: 'text', value: child.value.slice(end) })
            children.splice(index, 1, ...pieces)
            index += pieces.length - 1
          }
          continue
        }
        if (child.type !== 'element' || child.tagName === 'pre') continue
        let raw: string
        switch (child.tagName) {
          case 'a': raw = String(child.properties.href ?? ''); break
          case 'img': raw = String(child.properties.src ?? ''); break
          case 'code':
            raw = stripLeadingPathDecoration(textLabel(child).trim())
            if (!isInlineFilePath(raw)) continue
            break
          default: visit(child.children); continue
        }
        const file = chatAttachment(raw)
        if (child.tagName === 'img' && file?.remote && file.kind === 'photo') continue
        const label = child.tagName === 'code' ? file?.name ?? raw : textLabel(child)
        const element = mention(raw, start, label, child.tagName === 'code' ? 'code' : 'link', child.tagName === 'a' && child.children.some(isWebPreview) ? child.children : undefined)
        if (element) children[index] = element
        else if ((child.tagName === 'a' || child.tagName === 'img') && file && !file.remote) {
          // A group abbreviation or ambiguous filename has no single link destination.
          children[index] = { type: 'text', value: label || file.name }
        }
      }
    }

    visit(tree.children)
    if (!files.size) return
    tree.children.push({
      type: 'element', tagName: 'reply-attachment-list', properties: {},
      children: Array.from(files.values(), ref => ({
        type: 'element', tagName: 'li', properties: { id: ref.anchor }, children: [referenceElement(ref.folder ? 'reply-attachment-folder-card' : 'reply-attachment-card', ref.target, ref.label)]
      }))
    })
  }
}
