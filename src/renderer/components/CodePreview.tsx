import { useT } from '../i18n'

interface CodePreviewProps {
  filePath: string | null
  content: string | null
}

export default function CodePreview({ filePath, content }: CodePreviewProps) {
  const t = useT()

  if (!filePath) {
    return (
      <div className="flex h-full items-center justify-center p-4 text-center text-xs text-cream-faint">
        {t('panel.selectFile')}
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col">
      <div className="border-b border-line px-3 py-2 font-mono text-xs font-medium text-cream-dim">
        {filePath.split('/').pop()}
      </div>
      <pre className="flex-1 overflow-auto p-3 font-mono text-xs leading-relaxed text-cream/85">
        <code>{content ?? t('panel.loading')}</code>
      </pre>
    </div>
  )
}
