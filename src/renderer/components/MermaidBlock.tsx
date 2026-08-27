import { useEffect, useRef, useState } from 'react'
import { Code2, Eye } from 'lucide-react'
import { useT } from '../i18n'
import { useAppStore } from '../store'
import { renderMermaid } from '../lib/mermaid'

/**
 * ```mermaid blocks rendered as SVG diagrams, with a code/diagram toggle and
 * a graceful fallback to the raw source when the syntax doesn't parse.
 * Rendering lives in lib/mermaid (lazy-loaded, serialized, theme-aware).
 */
export default function MermaidBlock({ raw }: { raw: string }) {
  const t = useT()
  const theme = useAppStore((s) => s.theme)
  const [svg, setSvg] = useState<string | null>(null)
  const [failed, setFailed] = useState(false)
  const [showCode, setShowCode] = useState(false)
  // renderMermaid can't be cancelled: the generation token drops results of
  // superseded renders (raw/theme changed), `alive` those after unmount.
  const generation = useRef(0)

  useEffect(() => {
    const gen = ++generation.current
    let alive = true
    setSvg(null)
    setFailed(false)
    renderMermaid(raw, theme)
      .then((svg) => {
        if (alive && generation.current === gen) setSvg(svg)
      })
      .catch(() => {
        if (alive && generation.current === gen) setFailed(true)
      })
    return () => {
      alive = false
    }
  }, [raw, theme])

  if (failed) {
    // Unparseable — show the source like any other code block, with a note
    return (
      <div>
        <pre className="overflow-x-auto rounded-lg border border-line bg-ink-800 p-3.5 font-mono text-[13px] leading-6 text-cream/90">
          <code>{raw}</code>
        </pre>
        <div className="mt-1 text-[11px] text-cream-faint">{t('mermaid.failed')}</div>
      </div>
    )
  }

  return (
    <div className="overflow-hidden rounded-lg border border-line bg-ink-800">
      <div className="flex items-center justify-between border-b border-line bg-overlay px-3 py-1.5">
        <span className="font-mono text-[10px] uppercase tracking-[0.15em] text-cream-faint">
          mermaid
        </span>
        <button
          onClick={() => setShowCode((v) => !v)}
          title={showCode ? t('mermaid.showDiagram') : t('mermaid.showCode')}
          className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] text-cream-faint transition hover:bg-overlay-strong hover:text-cream"
        >
          {showCode ? <Eye size={11} /> : <Code2 size={11} />}
          {showCode ? t('mermaid.showDiagram') : t('mermaid.showCode')}
        </button>
      </div>
      {showCode || !svg ? (
        <pre className="overflow-x-auto p-3.5 font-mono text-[13px] leading-6 text-cream/90">
          <code>{raw}</code>
        </pre>
      ) : (
        <div
          className="mermaid-diagram overflow-x-auto p-3.5 [&_svg]:mx-auto [&_svg]:max-w-full"
          // mermaid.render returns sanitized SVG under securityLevel 'strict'
          dangerouslySetInnerHTML={{ __html: svg }}
        />
      )}
    </div>
  )
}
