import { useEffect, useState } from 'react'
import { ImageOff, Loader2 } from 'lucide-react'
import GenericToolContent from './generic'
import { ToolContentProps, toolInputObject, toolOutputText } from './index'
import { useT } from '../../i18n'

/** The Main side only ever captures to this basename pattern. */
function screenshotPath(toolCall: ToolContentProps['toolCall']): string | null {
  const obj = toolInputObject(toolCall.input)
  if (typeof obj.path === 'string' && obj.path) return obj.path
  const output = toolOutputText(toolCall.output)
  if (!output) return null
  try {
    const parsed = JSON.parse(output) as Record<string, unknown>
    if (typeof parsed.imagePath === 'string' && parsed.imagePath) return parsed.imagePath
  } catch {
    // output was plain text, not JSON
  }
  return null
}

/**
 * browser screenshot: show the captured frame inline instead of a JSON path
 * string. The bytes are served by Main from its own capture directory —
 * the renderer cannot read arbitrary paths and never receives one.
 */
export default function ScreenshotToolContent({ toolCall }: ToolContentProps) {
  const t = useT()
  const [dataUrl, setDataUrl] = useState<string | null>(null)
  const [failed, setFailed] = useState(false)
  const filePath = screenshotPath(toolCall)

  useEffect(() => {
    if (!filePath || toolCall.isError) return
    let active = true
    setDataUrl(null)
    setFailed(false)
    void window.electronAPI.readBrowserScreenshot(filePath).then((result) => {
      if (!active) return
      if (result) setDataUrl(result)
      else setFailed(true)
    })
    return () => {
      active = false
    }
  }, [filePath, toolCall.isError])

  if (!filePath) return <GenericToolContent toolCall={toolCall} />
  if (failed) {
    return (
      <div className="flex items-center gap-2 text-[12px] text-cream-faint">
        <ImageOff size={14} /> {t('tool.screenshot.unavailable')}
      </div>
    )
  }
  if (!dataUrl) {
    return (
      <div className="flex items-center gap-2 text-[12px] text-cream-faint">
        <Loader2 size={13} className="animate-spin" /> {t('tool.screenshot.loading')}
      </div>
    )
  }
  return (
    <img
      src={dataUrl}
      alt={t('tool.screenshot.alt')}
      className="max-h-80 max-w-full rounded-lg border border-line"
    />
  )
}
