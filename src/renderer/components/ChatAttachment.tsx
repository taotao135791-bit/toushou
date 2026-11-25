import { Fragment, memo, type ReactNode, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Download, FileText, FolderOpen, Image as ImageIcon, Sheet, X } from 'lucide-react'
import type { PromptImage } from '@shared/types'
import { chatAttachment, type AttachmentKind } from '@shared/chatAttachment'
import { useAppStore } from '../store'
import { useT } from '../i18n'
import audio from '../assets/file-types/audio.svg'
import docx from '../assets/file-types/docx.svg'
import pdf from '../assets/file-types/pdf.svg'
import photo from '../assets/file-types/photo.svg'
import pptx from '../assets/file-types/pptx.svg'
import txt from '../assets/file-types/txt.svg'
import video from '../assets/file-types/video.svg'
import xlsx from '../assets/file-types/xlsx.svg'
import zip from '../assets/file-types/zip.svg'

const icons: Record<AttachmentKind, string> = { audio, docx, pdf, photo, pptx, txt, video, xlsx, zip }
const mentionIcons: Partial<Record<AttachmentKind, typeof FileText>> = { photo: ImageIcon, xlsx: Sheet }

interface AttachmentProps { target: string; label?: string }

function useAttachment(target: string) {
  const file = chatAttachment(target)
  const t = useT()
  const [error, setError] = useState(false)
  const [pending, setPending] = useState(false)
  const inFlight = useRef(false)
  const activate = async (action: 'open' | 'save' | 'reveal' | 'open-folder') => {
    if (inFlight.current || (!file && action !== 'open-folder') || (file?.remote && action !== 'open')) return
    inFlight.current = true
    setPending(true)
    setError(false)
    try {
      if (file?.remote) {
        const result = await window.electronAPI.openExternalUrl(file.target)
        setError(!result.ok)
      } else {
        const { currentWorkspace: workspace, currentSessionId } = useAppStore.getState()
        if (!workspace) { setError(true); return }
        const result = action === 'open-folder'
          ? await window.electronAPI.openChatAttachmentFolder(workspace.id, target, currentSessionId)
          : await window.electronAPI.chatAttachment(workspace.id, target, action, currentSessionId)
        setError(result === 'unavailable')
      }
    } catch { setError(true) }
    finally { inFlight.current = false; setPending(false) }
  }
  return { file, t, pending, error, activate }
}

export function AttachmentMention({ target, label, fallbackHref, children }: AttachmentProps & { fallbackHref?: string; children?: ReactNode }) {
  const { file, t, pending, error, activate } = useAttachment(target)
  if (!file) return <>{children ?? (label || target)}</>
  const Icon = mentionIcons[file.kind] ?? FileText
  return <>
    <a href={file.remote ? file.target : fallbackHref} aria-disabled={pending || undefined} title={target}
      onClick={event => { event.preventDefault(); void activate('open') }}
      onAuxClick={event => { if (event.button === 1) { event.preventDefault(); void activate('open') } }}
      aria-label={children ? label || file.name : undefined} data-attachment-kind={file.kind}
      className="chat-attachment-mention focus-ring inline max-w-full rounded-sm text-left [overflow-wrap:anywhere]">
      {children ?? <><Icon size={14} aria-hidden="true" className="mr-1 inline-block align-[-2px]" />{label || file.name}</>}
    </a>
    {error && <span role="status" className="px-1 text-xs text-amber-700">{t('chat.attachmentUnavailable')}</span>}
  </>
}

export function AttachmentFolderMention({ target, label }: AttachmentProps) {
  const { t, pending, error, activate } = useAttachment(target)
  return <>
    <button type="button" disabled={pending} onClick={() => void activate('open-folder')}
      aria-label={t('chat.attachmentOpenFolder') + ' · ' + (label || target)} title={target}
      className="chat-attachment-mention focus-ring inline max-w-full rounded-sm text-left align-baseline text-[#1973ca] [overflow-wrap:anywhere] dark:text-[#90bff0]">
      <FolderOpen size={14} aria-hidden="true" className="mr-1 inline-block align-[-2px]" />{label || target}
    </button>
    {error && <span role="status" className="px-1 text-xs text-amber-700">{t('chat.attachmentFolderUnavailable')}</span>}
  </>
}

export function AttachmentFolderCard({ target, label }: AttachmentProps) {
  const { t, pending, error, activate } = useAttachment(target)
  const name = label || target.split(/[\\/]/).filter(Boolean).pop() || target
  const platform = typeof window === 'undefined' ? undefined : window.electronAPI?.platform
  const open = t(platform === 'darwin' ? 'chat.attachmentOpenFolderFinder' : platform === 'win32' ? 'chat.attachmentOpenFolderExplorer' : 'chat.attachmentOpenFolder')
  return <span className="chat-attachment-card my-1 inline-flex max-w-full items-center rounded-xl border border-line bg-ink-850 px-2 align-middle text-cream">
    <button type="button" disabled={pending} onClick={() => void activate('open-folder')} aria-label={open + ' · ' + name}
      title={target} className="focus-ring flex min-w-0 flex-1 items-center gap-2.5 rounded-lg py-2 pl-1 pr-2 text-left hover:bg-overlay">
      <FolderOpen size={26} aria-hidden="true" className="mx-[3px] shrink-0 text-cream-dim" />
      <span className="min-w-0"><span className="block truncate text-[13px] font-medium">{name}</span>
        <span className="block truncate text-[11px] text-cream-faint">{open}</span>
      </span>
    </button>
    {error && <span role="status" className="px-1 text-xs text-amber-700">{t('chat.attachmentFolderUnavailable')}</span>}
  </span>
}

export function AttachmentCard({ target, label }: AttachmentProps) {
  const { file, t, pending, error, activate } = useAttachment(target)
  if (!file) return <>{label ?? target}</>
  const reveal = t('chat.attachmentShowInFolder')
  const { revealOnly } = file
  const open = revealOnly ? reveal : t(file.sandbox ? 'chat.attachmentLocate' : 'chat.attachmentOpen')
  const save = t('chat.attachmentSave')
  const platform = typeof window === 'undefined' ? undefined : window.electronAPI?.platform
  const revealTitle = platform === 'darwin' ? t('chat.openInFinder') : platform === 'win32' ? t('chat.attachmentShowInExplorer') : reveal
  return <span className="chat-attachment-card my-1 inline-flex max-w-full items-center gap-1 rounded-xl border border-line bg-ink-850 px-2 align-middle text-cream">
    <button type="button" disabled={pending} onClick={() => void activate(revealOnly ? 'reveal' : 'open')} aria-label={open + ' · ' + file.name}
      title={revealOnly ? revealTitle : target} className="focus-ring flex min-w-0 flex-1 items-center gap-2.5 rounded-lg py-2 pl-1 pr-2 text-left hover:bg-overlay">
      <img src={icons[file.kind]} alt="" width={30} height={30} className="m-0 h-8 w-8 shrink-0" />
      <span className="min-w-0"><span className="block truncate text-[13px] font-medium">{label || file.name}</span>
        <span className="block truncate text-[11px] text-cream-faint">{file.ext.toUpperCase()}{(file.sandbox || revealOnly) && ' · ' + open}{label && label !== file.name ? ' · ' + file.name : ''}</span>
      </span>
    </button>
    {!file.remote && !revealOnly && <button type="button" disabled={pending} onClick={() => void activate('reveal')}
      title={revealTitle} aria-label={reveal + ' · ' + file.name}
      className="focus-ring inline-flex min-h-8 shrink-0 items-center gap-1 rounded-lg px-1.5 text-[11px] text-cream-dim hover:bg-overlay">
      <FolderOpen size={14} aria-hidden="true" />{reveal}
    </button>}
    {!file.remote && <button type="button" disabled={pending} aria-label={save + ' · ' + file.name} title={save}
      className="focus-ring shrink-0 rounded-lg p-2 text-cream-dim hover:bg-overlay" onClick={() => void activate('save')}><Download size={14} /></button>}
    {error && <span role="status" className="px-1 text-xs text-amber-700">{t('chat.attachmentUnavailable')}</span>}
  </span>
}

export function PromptAttachments({ text }: { text: string }) {
  if (!text.includes('@')) return <>{text}</>
  return <>{text.split('\n').map((line, index) => <Fragment key={index}>{index > 0 && '\n'}{line.startsWith('@') && chatAttachment(line.slice(1))
    ? <AttachmentCard target={line.slice(1)} /> : line}</Fragment>)}</>
}

export const AttachedImage = memo(function AttachedImage({ image, previewUrl }: {
  image: Pick<PromptImage, 'data' | 'mimeType'>
  previewUrl?: string
}) {
  const dialog = useRef<HTMLDialogElement>(null)
  const zh = useAppStore(s => s.language === 'zh')
  const [open, setOpen] = useState(false)
  const url = previewUrl ?? ('data:' + image.mimeType + ';base64,' + image.data)
  const title = zh ? '查看图片' : 'View image'
  useEffect(() => {
    if (open) dialog.current?.showModal()
  }, [open])
  return <>
    <button type="button" aria-label={title} title={title} className="focus-ring block cursor-zoom-in rounded-lg" onClick={() => setOpen(true)}>
      <img src={url} loading="lazy" decoding="async" alt="" className="h-14 w-14 rounded-lg border border-line object-cover" />
    </button>
    {open && createPortal(<dialog ref={dialog} aria-label={title} onClose={() => setOpen(false)}
      onClick={event => { if (event.target === dialog.current) dialog.current?.close() }}
      className="m-auto max-h-[94vh] max-w-[94vw] rounded-2xl border border-line bg-ink-850 p-0 backdrop:bg-black/60">
      <div className="p-3"><div className="mb-2 flex justify-end gap-2"><a href={url} download={'image.' + image.mimeType.split('/')[1]} aria-label={zh ? '下载图片' : 'Download image'} className="rounded p-2"><Download size={16} /></a>
        <button type="button" autoFocus className="rounded p-2" onClick={() => dialog.current?.close()} aria-label={zh ? '关闭' : 'Close'}><X size={16} /></button></div>
        <img src={url} alt={zh ? '附件图片' : 'Attached image'} className="mx-auto max-h-[80vh] max-w-[88vw] object-contain" />
      </div>
    </dialog>, document.body)}
  </>
})
