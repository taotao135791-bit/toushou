import { useCallback, useEffect, useState } from 'react'
import { Loader2, PenLine, Plus, Trash2, Zap } from 'lucide-react'
import { useT } from '../i18n'
import { ConfirmDialog, type ConfirmDialogRequest } from './ConfirmDialog'

interface AdsCopyModelRow {
  id: string
  name: string
  baseUrl: string
  protocol: 'openai' | 'anthropic'
  model: string
  inPool: boolean
  createdAt: number
}

const inputClass =
  'w-full rounded-lg border border-line bg-ink-850 px-2.5 py-1.5 text-[13px] text-cream outline-none transition focus:border-accent/50'
const actionClass =
  'focus-ring inline-flex items-center gap-1.5 rounded-full border border-line px-2.5 py-1 text-[12px] text-cream-dim transition hover:bg-overlay disabled:opacity-40'

/**
 * 文案模型池（连接页独立小节）：给 ads-copy 工具配置专属生成模型——
 * 自定义供应商（OpenAI 兼容 / Anthropic 协议 + API Key），可勾选入池并发生成。
 * 与对话模型完全独立：密钥只存主进程加密库，渲染层永远拿不到。
 */
export default function AdsCopyModelsSection() {
  const t = useT()
  const [rows, setRows] = useState<AdsCopyModelRow[] | null>(null)
  const [name, setName] = useState('')
  const [baseUrl, setBaseUrl] = useState('')
  const [protocol, setProtocol] = useState<'openai' | 'anthropic'>('openai')
  const [model, setModel] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [testing, setTesting] = useState<string | null>(null)
  const [testResult, setTestResult] = useState<Record<string, { ok: boolean; detail: string }>>({})
  const [pendingDelete, setPendingDelete] = useState<ConfirmDialogRequest | null>(null)

  const refresh = useCallback(() => {
    window.electronAPI
      .adsCopyModelsList()
      .then(setRows)
      .catch(() => setRows([]))
  }, [])

  useEffect(() => {
    refresh()
  }, [refresh])

  const add = async () => {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      const result = await window.electronAPI.adsCopyModelsUpsert({ name, baseUrl, protocol, model, apiKey })
      if (result.ok) {
        setName('')
        setBaseUrl('')
        setModel('')
        setApiKey('')
        refresh()
      } else setError(result.error ?? 'save-failed')
    } catch {
      setError('save-failed')
    } finally {
      setBusy(false)
    }
  }

  const togglePool = async (row: AdsCopyModelRow) => {
    const current = rows ?? []
    const poolIds = row.inPool
      ? current.filter((item) => item.inPool && item.id !== row.id).map((item) => item.id)
      : [...current.filter((item) => item.inPool).map((item) => item.id), row.id]
    await window.electronAPI.adsCopyModelsSetPool(poolIds)
    refresh()
  }

  const test = async (row: AdsCopyModelRow) => {
    if (testing) return
    setTesting(row.id)
    try {
      const result = await window.electronAPI.adsCopyModelsTest(row.id)
      setTestResult((prev) => ({ ...prev, [row.id]: { ok: result.ok, detail: result.ok ? '' : (result.error ?? '') } }))
    } catch {
      setTestResult((prev) => ({ ...prev, [row.id]: { ok: false, detail: 'network' } }))
    } finally {
      setTesting(null)
    }
  }

  const remove = async (id: string) => {
    await window.electronAPI.adsCopyModelsRemove(id)
    refresh()
  }

  return (
    <section className="rounded-2xl border border-line bg-ink-900/60 p-4">
      <div className="mb-1 flex items-center gap-2">
        <PenLine size={14} className="text-accent" />
        <h2 className="text-[14px] font-semibold text-cream">{t('adsCopy.section.title')}</h2>
      </div>
      <p className="mb-3 text-[12px] leading-5 text-cream-faint">{t('adsCopy.section.subtitle')}</p>

      {rows === null ? (
        <Loader2 size={14} className="animate-spin text-cream-faint" />
      ) : (
        <>
          {rows.length === 0 && <p className="mb-3 text-[12px] text-cream-faint">{t('adsCopy.empty')}</p>}
          {rows.map((row) => {
            const last = testResult[row.id]
            return (
              <div key={row.id} className="mb-1.5 flex items-center gap-2 rounded-xl border border-line bg-ink-900/60 px-3 py-2.5">
                <input
                  type="checkbox"
                  checked={row.inPool}
                  onChange={() => void togglePool(row)}
                  aria-label={t('adsCopy.poolToggle')}
                  className="h-4 w-4 accent-[var(--accent)]"
                />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="truncate text-[12px] font-medium text-cream">{row.name}</span>
                    <span className="rounded-full border border-line px-1.5 py-px text-[10px] uppercase text-cream-faint">
                      {row.protocol}
                    </span>
                    {row.inPool && <span className="rounded-full bg-accent/10 px-1.5 py-px text-[10px] text-accent">{t('adsCopy.inPool')}</span>}
                  </div>
                  <div className="truncate text-[11px] leading-4 text-cream-faint/70">
                    {row.model} · {row.baseUrl.replace(/^https:\/\//, '').split('/')[0]}
                  </div>
                  {last && !last.ok && (
                    <div className="text-[11px] text-red-500">{t('adsCopy.testFailed', { detail: last.detail || 'error' })}</div>
                  )}
                  {last?.ok && <div className="text-[11px] text-emerald-500">{t('adsCopy.testOk')}</div>}
                </div>
                <button type="button" className={actionClass} disabled={testing !== null} onClick={() => void test(row)}>
                  {testing === row.id ? <Loader2 size={12} className="animate-spin" /> : <Zap size={12} />}
                  {t('adsCopy.test')}
                </button>
                <button
                  type="button"
                  className="rounded-md p-1 text-cream-faint transition hover:bg-red-500/10 hover:text-red-500"
                  title={t('adsCopy.remove')}
                  onClick={() =>
                    setPendingDelete({
                      title: t('adsCopy.deleteDialog.title'),
                      body: t('adsCopy.deleteDialog.body', { name: row.name }),
                      danger: true,
                      onConfirm: () => void remove(row.id)
                    })
                  }
                >
                  <Trash2 size={13} />
                </button>
              </div>
            )
          })}

          <div className="mt-3 grid grid-cols-1 gap-2 rounded-xl border border-line bg-ink-850/40 p-3 md:grid-cols-2">
            <input className={inputClass} placeholder={t('adsCopy.form.name')} value={name} onChange={(e) => setName(e.target.value)} maxLength={60} />
            <input className={inputClass} placeholder={t('adsCopy.form.baseUrl')} value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} maxLength={300} />
            <select
              className={inputClass}
              value={protocol}
              onChange={(e) => setProtocol(e.target.value === 'anthropic' ? 'anthropic' : 'openai')}
              aria-label={t('adsCopy.form.protocol')}
            >
              <option value="openai">OpenAI 兼容</option>
              <option value="anthropic">Anthropic</option>
            </select>
            <input className={inputClass} placeholder={t('adsCopy.form.model')} value={model} onChange={(e) => setModel(e.target.value)} maxLength={120} />
            <input
              className={inputClass}
              type="password"
              placeholder={t('adsCopy.form.apiKey')}
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              maxLength={400}
            />
            <button
              type="button"
              className="focus-ring inline-flex items-center justify-center gap-1.5 rounded-full bg-cream px-3 py-1.5 text-[12px] font-medium text-ink-950 transition hover:opacity-90 disabled:opacity-40"
              disabled={busy || !name.trim() || !baseUrl.trim() || !model.trim() || !apiKey.trim()}
              onClick={() => void add()}
            >
              <Plus size={12} />
              {t('adsCopy.form.add')}
            </button>
            {error && <p className="text-[11px] text-red-500 md:col-span-2">{t(`adsCopy.error.${error}` as Parameters<typeof t>[0])}</p>}
          </div>
        </>
      )}
      {pendingDelete && <ConfirmDialog request={pendingDelete} onClose={() => setPendingDelete(null)} />}
    </section>
  )
}
