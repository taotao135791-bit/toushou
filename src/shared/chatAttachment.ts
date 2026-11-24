const types = {
  xlsx: ['csv', 'tsv', 'xls', 'xlsx', 'ods', 'numbers'],
  docx: ['doc', 'docx', 'odt', 'rtf', 'pages'],
  pptx: ['ppt', 'pptx', 'odp', 'key'],
  pdf: ['pdf'],
  photo: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'heic', 'avif', 'tiff', 'bmp'],
  video: ['mp4', 'm4v', 'mov', 'webm', 'mkv', 'avi'],
  audio: ['mp3', 'm4a', 'wav', 'aac', 'flac', 'ogg'],
  zip: ['zip', '7z', 'rar', 'gz', 'tar'],
  txt: ['txt', 'md', 'log', 'json', 'jsonl', 'yaml', 'yml', 'srt', 'vtt']
}
export type AttachmentKind = keyof typeof types
const fileTypes = new Map(Object.entries(types).flatMap(([kind, extensions]) =>
  extensions.map(ext => [ext, kind as AttachmentKind] as const)))

export function chatAttachment(raw: unknown) {
  if (typeof raw !== 'string' || raw.length > 4096 || !raw.trim()) return null
  let target = raw.trim()
  const remote = /^https?:\/\//i.test(target)
  const sandbox = /^sandbox:\/mnt\/data\//i.test(target)
  let file = target
  try {
    if (remote) file = decodeURIComponent(new URL(target).pathname)
    else {
      if (/^file:\/\//i.test(file)) {
        const url = new URL(file)
        if (url.hostname || url.search || url.hash) return null
        file = url.pathname.replace(/^\/([a-z]:\/)/i, '$1')
      } else if (sandbox) file = file.slice('sandbox:'.length)
      else if (/^[a-z][\w+.-]*:/i.test(file) && !/^[a-z]:(?:[\\/]|%5c|%2f)/i.test(file)) return null
      // Paths copied from a terminal can include a literal percent sign.
      if (/%[a-f\d]{2}/i.test(file)) file = decodeURIComponent(file.replace(/%(?![a-f\d]{2})/gi, '%25'))
      if (/^[\\/]{2}|[\u0000-\u001f\u007f]/.test(file) || file.split(/[\\/]/).includes('..')) return null
      if (file.replace(/^[a-z]:[\\/]/i, '').includes(':')) return null
      target = sandbox ? 'sandbox:' + file : file
    }
  } catch { return null }
  const name = file.split(/[\\/]/).pop() ?? ''
  const dot = name.lastIndexOf('.')
  const ext = name.slice(dot + 1).toLowerCase()
  const kind = dot > 0 ? fileTypes.get(ext) : undefined
  return kind ? { name, ext, kind, target, remote, sandbox } : null
}
