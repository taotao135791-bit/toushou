import { useCallback, useEffect, useState } from 'react'
import {
  Plug,
  Trash2,
  FlaskConical,
  LoaderCircle,
  CheckCircle2,
  AlertCircle,
  ClipboardPaste,
  ArrowUpRight,
  Settings2
} from 'lucide-react'
import { McpConnectionInfo } from '@shared/connections'
import { useT } from '../i18n'

/**
 * socialpeta MCP 连接卡片：常用路径只需粘贴官网令牌（名称/地址/认证全部
 * 预配）；自定义服务与粘贴 JSON 收进进阶区。令牌只进主进程，列表永远是
 * 脱敏端点。
 */
export const SOCIALPETA_MCP_PRESET = {
  name: 'socialpeta_mcp',
  url: 'https://mcp.socialpeta.com/mcp/',
  tokenPage: 'https://socialpeta.com/modules/global/user/ai-token'
} as const

type Mode = 'socialpeta' | 'custom' | 'paste'

export default function McpConnectionsSection() {
  const t = useT()
  const [entries, setEntries] = useState<McpConnectionInfo[] | null>(null)
  const [mode, setMode] = useState<Mode>('socialpeta')
  const [token, setToken] = useState('')
  const [name, setName] = useState('')
  const [url, setUrl] = useState('')
  const [customToken, setCustomToken] = useState('')
  const [rawJson, setRawJson] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [testing, setTesting] = useState<string | null>(null)
  const [testResult, setTestResult] = useState<Record<string, { ok: boolean; detail: string }>>({})

  const refresh = useCallback(() => {
    window.electronAPI
      .mcpList()
      .then(setEntries)
      .catch(() => setEntries([]))
  }, [])

  useEffect(() => {
    refresh()
  }, [refresh])

  const add = async () => {
    if (busy) return
    setBusy(true)
    setError(null)
    setNotice(null)
    try {
      const input =
        mode === 'socialpeta'
          ? { name: SOCIALPETA_MCP_PRESET.name, url: SOCIALPETA_MCP_PRESET.url, token }
          : mode === 'custom'
            ? { name, url, token: customToken }
            : { rawJson, name }
      const result = await window.electronAPI.mcpAdd(input)
      if (result.ok) {
        setNotice(t('connections.mcpAdded', { name: result.name }))
        setToken('')
        setName('')
        setUrl('')
        setCustomToken('')
        setRawJson('')
        refresh()
      } else {
        setError(result.error)
      }
    } finally {
      setBusy(false)
    }
  }

  const remove = async (entry: McpConnectionInfo) => {
    const result = await window.electronAPI.mcpRemove(entry.name)
    if (!result.ok) setError(result.error)
    refresh()
  }

  const test = async (entry: McpConnectionInfo) => {
    setTesting(entry.name)
    try {
      const result = await window.electronAPI.mcpTest(entry.name)
      setTestResult((prev) => ({ ...prev, [entry.name]: result }))
    } finally {
      setTesting(null)
    }
  }

  const inputCls =
    'w-full rounded-lg border border-line bg-ink-800 px-3 py-2 text-[13px] text-cream outline-none placeholder:text-cream-faint focus:border-accent/60'

  const chip = (active: boolean) =>
    `rounded-full border px-3 py-1 transition ${
      active ? 'border-line bg-ink-800 text-cream' : 'border-transparent text-cream-faint hover:text-cream'
    }`

  return (
    <section className="overflow-hidden rounded-[18px] border border-line bg-ink-850 shadow-card">
      <div className="flex items-start justify-between gap-4 border-b border-line px-5 py-4">
        <div className="flex min-w-0 items-center gap-3">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-accent-soft text-accent">
            <Plug size={18} />
          </div>
          <div className="min-w-0">
            <h2 className="text-[15px] font-semibold text-cream">{t('connections.mcpTitle')}</h2>
            <p className="mt-1 max-w-[520px] text-[12px] leading-5 text-cream-faint">
              {t('connections.mcpDescription')}{' '}
              <button
                type="button"
                onClick={() => void window.electronAPI.openExternalUrl(SOCIALPETA_MCP_PRESET.tokenPage)}
                className="inline-flex items-center gap-0.5 text-accent underline decoration-accent/40 underline-offset-2 hover:decoration-accent"
              >
                {t('connections.mcpTokenLink')}
                <ArrowUpRight size={11} />
              </button>
            </p>
          </div>
        </div>
      </div>

      <div className="px-5 py-5">
        {(entries?.length ?? 0) > 0 && (
          <div className="mb-4 space-y-2">
            {entries?.map((entry) => (
              <div
                key={entry.name}
                className="flex flex-wrap items-center gap-2 rounded-xl bg-overlay px-3 py-2.5"
              >
                <span className="font-mono text-[12.5px] text-cream">{entry.name}</span>
                <span className="rounded bg-ink-850 px-1.5 py-0.5 font-mono text-[10px] uppercase text-cream-faint">
                  {entry.transport}
                </span>
                <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-cream-faint">
                  {entry.endpointMasked}
                </span>
                {testResult[entry.name] &&
                  (testResult[entry.name].ok ? (
                    <span className="flex items-center gap-1 text-[11px] text-emerald-600 dark:text-emerald-400">
                      <CheckCircle2 size={11} /> {testResult[entry.name].detail}
                    </span>
                  ) : (
                    <span className="flex items-center gap-1 text-[11px] text-amber-600 dark:text-amber-300">
                      <AlertCircle size={11} /> {testResult[entry.name].detail}
                    </span>
                  ))}
                <button
                  type="button"
                  onClick={() => void test(entry)}
                  disabled={testing !== null}
                  title={t('connections.mcpTest')}
                  className="rounded-md p-1.5 text-cream-faint transition hover:bg-overlay-strong hover:text-cream disabled:opacity-50"
                >
                  {testing === entry.name ? (
                    <LoaderCircle size={13} className="animate-spin" />
                  ) : (
                    <FlaskConical size={13} />
                  )}
                </button>
                {entry.managed && (
                  <button
                    type="button"
                    onClick={() => void remove(entry)}
                    title={t('connections.mcpRemove')}
                    className="rounded-md p-1.5 text-cream-faint transition hover:bg-red-500/10 hover:text-red-500"
                  >
                    <Trash2 size={13} />
                  </button>
                )}
              </div>
            ))}
          </div>
        )}

        <div className="mb-3 flex flex-wrap gap-1.5 text-[11px]">
          <button type="button" onClick={() => setMode('socialpeta')} className={chip(mode === 'socialpeta')}>
            {t('connections.mcpModeSocialpeta')}
          </button>
          <button type="button" onClick={() => setMode('custom')} className={`flex items-center gap-1 ${chip(mode === 'custom')}`}>
            <Settings2 size={11} />
            {t('connections.mcpModeForm')}
          </button>
          <button type="button" onClick={() => setMode('paste')} className={`flex items-center gap-1 ${chip(mode === 'paste')}`}>
            <ClipboardPaste size={11} />
            {t('connections.mcpModePaste')}
          </button>
        </div>

        {mode === 'socialpeta' ? (
          <div className="space-y-2.5">
            <input
              value={token}
              onChange={(e) => setToken(e.target.value)}
              type="password"
              placeholder={t('connections.mcpTokenOnlyPlaceholder')}
              className={inputCls}
            />
            <p className="text-[11px] leading-5 text-cream-faint">{t('connections.mcpSocialpetaHint')}</p>
          </div>
        ) : mode === 'custom' ? (
          <div className="space-y-2.5">
            <div className="grid gap-2.5 sm:grid-cols-2">
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={t('connections.mcpNamePlaceholder')}
                className={inputCls}
              />
              <input
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder={t('connections.mcpUrlPlaceholder')}
                className={inputCls}
              />
            </div>
            <input
              value={customToken}
              onChange={(e) => setCustomToken(e.target.value)}
              type="password"
              placeholder={t('connections.mcpTokenPlaceholder')}
              className={inputCls}
            />
          </div>
        ) : (
          <div className="space-y-2.5">
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t('connections.mcpNamePlaceholder')}
              className={inputCls}
            />
            <textarea
              value={rawJson}
              onChange={(e) => setRawJson(e.target.value)}
              placeholder={t('connections.mcpPastePlaceholder')}
              rows={5}
              className={`${inputCls} font-mono text-[12px]`}
            />
          </div>
        )}

        {error && <p className="mt-2 text-[12px] text-red-500">{error}</p>}
        {notice && <p className="mt-2 text-[12px] text-emerald-600 dark:text-emerald-400">{notice}</p>}

        <div className="mt-4 flex flex-wrap items-center gap-3">
          <button
            type="button"
            onClick={() => void add()}
            disabled={busy}
            className="flex items-center gap-2 rounded-full bg-accent px-4 py-2 text-[12px] font-medium text-white shadow-card hover:bg-accent-bright disabled:opacity-50"
          >
            {busy ? <LoaderCircle size={14} className="animate-spin" /> : <Plug size={14} />}
            {t('connections.mcpAdd')}
          </button>
          <span className="text-[11px] text-cream-faint">{t('connections.mcpHint')}</span>
        </div>
      </div>
    </section>
  )
}
