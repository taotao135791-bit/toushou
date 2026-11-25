import type { ExtraProps } from 'react-markdown'
import { chatAttachment } from '@shared/chatAttachment'

type Element = NonNullable<ExtraProps['node']>
type Child = Element['children'][number]
interface Reference { target: string; label: string; anchor: string }

// Explicit paths can contain spaces. A bare filename needs a tighter shape
// so a command such as `cat report.csv` remains a copyable code example.
export function isInlineFilePath(path: string): boolean {
  return /^(?:[./~][\\/]|\/|[a-z]:[\\/]|sandbox:|file:)/i.test(path)
    || /^[\p{L}\p{N}_.()%-]+(?:[\\/][\p{L}\p{N}_.()%-]+)*$/u.test(path)
    || /^[\p{L}\p{N}_.()%-]+[\\/][\p{L}\p{N}_.()% \\/-]+$/u.test(path)
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
  return (tree: { children: Child[] }): void => {
    const files = new Map<string, Reference>()

    function visit(children: Child[]): void {
      for (const [index, child] of children.entries()) {
        if (child.type !== 'element' || child.tagName === 'pre') continue
        let target: string
        switch (child.tagName) {
          case 'a': target = String(child.properties.href ?? ''); break
          case 'img': target = String(child.properties.src ?? ''); break
          case 'code':
            target = textLabel(child).trim()
            if (!isInlineFilePath(target)) continue
            break
          default: visit(child.children); continue
        }
        const file = chatAttachment(target)
        // An ordinary link owns its label and thumbnail. Never make nested
        // buttons inside it. Embedded web photos keep their original preview.
        if (!file || (child.tagName === 'img' && file.remote && file.kind === 'photo')) continue
        const label = child.tagName === 'code' ? file.name : textLabel(child) || file.name
        // Canonicalize only the lookup key. Main must validate the original
        // target (decoding percent-escapes twice changes literal filenames).
        let key = file.target
        if (file.remote) key = new URL(key).href
        else if (/^[a-z]:[\\/]/i.test(key)) key = key.replace(/\\/g, '/')
        else key = key.replace(/^(?:\.\/)+/, '')
        const card = files.get(key) ?? { target, label, anchor: idPrefix + '-' + files.size }
        files.set(key, card)
        const mention = referenceElement('reply-attachment-mention', target, label)
        mention.properties.fallbackHref = '#' + card.anchor
        if (child.tagName === 'a' && child.children.some(isWebPreview)) mention.children = child.children
        children[index] = mention
      }
    }

    visit(tree.children)
    if (!files.size) return
    tree.children.push({
      type: 'element', tagName: 'reply-attachment-list', properties: {},
      children: Array.from(files.values(), ref => ({
        type: 'element', tagName: 'li', properties: { id: ref.anchor }, children: [referenceElement('reply-attachment-card', ref.target, ref.label)]
      }))
    })
  }
}
