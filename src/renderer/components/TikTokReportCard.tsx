import { useEffect, useState } from 'react'
import { AlertTriangle, CheckCircle2, LoaderCircle, LockKeyhole, RefreshCw, Unplug } from 'lucide-react'
import { I18nKey, useT } from '../i18n'
import { TikTokCredentialInfo, TikTokReportStatus } from '@shared/tiktokReport'

const emptyInfo: TikTokCredentialInfo = {
  configured: false,
  mode: 'none',
  tokenMasked: '',
  hasRefreshToken: false,
  advertiserIds: []
}

const emptyStatus: TikTokReportStatus = {
  configured: false,
  autoRefresh: false,
  refreshing: false,
  info: emptyInfo
}

/** Stable Main error codes → i18n keys (unknown codes render verbatim). */
const ERROR_KEYS: Record<string, I18nKey> = {
  'invalid-input': 'tiktok.errorInvalidInput',
  'missing-token': 'tiktok.errorMissingToken',
  'invalid-token': 'tiktok.errorInvalidToken',
  'invalid-app-id': 'tiktok.errorInvalidAppId',
  'invalid-secret': 'tiktok.errorInvalidSecret',
  'invalid-refresh-token': 'tiktok.errorInvalidRefreshToken',
  'invalid-advertisers': 'tiktok.errorInvalidAdvertisers',
  'not-configured': 'tiktok.errorNotConfigured',
  'refresh-in-progress': 'tiktok.errorRefreshInProgress',
  'token-expired': 'tiktok.errorTokenExpired'
}

type Translate = (key: I18nKey, vars?: Record<string, string | number>) => string

function errorMessage(t: Translate, error: string | undefined): string {
  if (!error) return ''
  const key = ERROR_KEYS[error]
  return key ? t(key) : error
}

/**
 * TikTok 报表接入卡片：配置 TikTok Open API 凭据（粘贴 access token 或
 * OAuth 长期凭据），手动「立即更新」或开启每 30 分钟自动刷新，数据整体
 * 覆写进看板的 "TikTok 报表" 数据集。渲染层只见脱敏投影。
 */
export default function TikTokReportCard() {
  const t = useT()
  const [status, setStatus] = useState<TikTokReportStatus>(emptyStatus)
  const [appId, setAppId] = useState('')
  const [appSecret, setAppSecret] = useState('')
  const [accessToken, setAccessToken] = useState('')
  const [advertiserIds, setAdvertiserIds] = useState('')
  const [saveBusy, setSaveBusy] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [refreshBusy, setRefreshBusy] = useState(false)
  const [refreshResult, setRefreshResult] = useState<'ok' | 'fail' | null>(null)

  useEffect(() => {
    let active = true
    void window.electronAPI.tiktokReportStatus().then((value) => {
      if (active) setStatus(value)
    })
    const unsubscribe = window.electronAPI.onTiktokReportStatus((value) => {
      if (active) setStatus(value)
    })
    return () => {
      active = false
      unsubscribe()
    }
  }, [])

  const info = status.info

  const save = async () => {
    setSaveBusy(true)
    setSaveError(null)
    const ids = advertiserIds
      .split(/[,，;\s]+/)
      .map((piece) => piece.trim())
      .filter(Boolean)
    const result = await window.electronAPI.tiktokReportSetCredentials({
      appId: appId.trim() || undefined,
      appSecret: appSecret || undefined,
      accessToken: accessToken.trim(),
      advertiserIds: ids.length > 0 ? ids : undefined
    })
    if (result.ok) {
      setStatus((current) => ({ ...current, info: result.info }))
      setAccessToken('')
      setAppSecret('')
    } else {
      setSaveError(errorMessage(t, result.error))
    }
    setSaveBusy(false)
  }

  const refreshNow = async () => {
    setRefreshBusy(true)
    setRefreshResult(null)
    const outcome = await window.electronAPI.tiktokReportRefreshNow()
    setRefreshResult(outcome.ok ? 'ok' : 'fail')
    if (!outcome.ok) setSaveError(null)
    setRefreshBusy(false)
  }

  const toggleAutoRefresh = async () => {
    const next = await window.electronAPI.tiktokReportSetAutoRefresh(!status.autoRefresh)
    setStatus(next)
  }

  const disconnect = async () => {
    // 报表接入没有独立 disconnect 通道：清空开关并覆盖为空记录由
    // setAutoRefresh(false) + 重新保存实现。这里只关掉自动刷新。
    if (status.autoRefresh) await window.electronAPI.tiktokReportSetAutoRefresh(false)
  }

  const canSave = accessToken.trim() !== '' || info.configured
  const lastRefresh = status.lastRefreshAt ? new Date(status.lastRefreshAt).toLocaleString() : null
  const tokenExpiry = info.expiresAt ? new Date(info.expiresAt).toLocaleString() : null
  const statusError = errorMessage(t, status.lastError)

  return (
    <section className="rounded-2xl border border-line bg-ink-850 p-5 shadow-card">
      <div className="flex items-start justify-between gap-4">
        <div className="flex items-center gap-2.5">
          <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-overlay text-cream">
            <svg viewBox="0 0 24 24" className="h-4 w-4" aria-hidden="true">
              <path
                fill="currentColor"
                d="M16.6 5.82A4.28 4.28 0 0 1 15.54 3h-3.09v12.4a2.59 2.59 0 1 1-1.84-2.48V9.77a5.68 5.68 0 1 0 4.93 5.63V8.87a7.35 7.35 0 0 0 4.3 1.38V7.16a4.28 4.28 0 0 1-3.24-1.34Z"
              />
            </svg>
          </span>
          <div>
            <h2 className="text-[15px] font-semibold text-cream">{t('tiktok.title')}</h2>
            <p className="mt-1 max-w-[520px] text-[12px] leading-5 text-cream-faint">{t('tiktok.description')}</p>
          </div>
        </div>
        <span
          className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium ${
            status.configured ? 'bg-emerald-500/12 text-emerald-600 dark:text-emerald-400' : 'bg-overlay text-cream-faint'
          }`}
        >
          {status.configured ? t('tiktok.configured') : t('tiktok.notConfigured')}
        </span>
      </div>

      {/* 状态行：脱敏凭据 + 上次刷新 + 最近错误 */}
      {status.configured && (
        <div className="mt-4 grid gap-2 sm:grid-cols-2">
          <div className="flex items-center justify-between rounded-xl bg-overlay px-3 py-2.5 text-[12px]">
            <span className="text-cream-faint">{t('tiktok.tokenMasked')}</span>
            <span className="font-mono text-cream-dim">{info.tokenMasked || '—'}</span>
          </div>
          <div className="flex items-center justify-between rounded-xl bg-overlay px-3 py-2.5 text-[12px]">
            <span className="text-cream-faint">{t('tiktok.mode')}</span>
            <span className="text-cream-dim">{info.mode === 'oauth' ? t('tiktok.modeOauth') : t('tiktok.modePasted')}</span>
          </div>
          <div className="flex items-center justify-between rounded-xl bg-overlay px-3 py-2.5 text-[12px]">
            <span className="text-cream-faint">{t('tiktok.lastRefresh')}</span>
            <span className="text-cream-dim">{lastRefresh ?? '—'}</span>
          </div>
          <div className="flex items-center justify-between rounded-xl bg-overlay px-3 py-2.5 text-[12px]">
            <span className="text-cream-faint">{t('tiktok.tokenExpires')}</span>
            <span className="text-cream-dim">{tokenExpiry ?? '—'}</span>
          </div>
          {status.lastRowCount !== undefined && (
            <div className="flex items-center justify-between rounded-xl bg-overlay px-3 py-2.5 text-[12px]">
              <span className="text-cream-faint">{t('tiktok.lastRowCount')}</span>
              <span className="text-cream-dim">{status.lastRowCount}</span>
            </div>
          )}
        </div>
      )}

      {statusError && (
        <div className="mt-3 flex items-start gap-1.5 rounded-xl border border-amber-500/30 bg-amber-500/8 px-3 py-2.5 text-[12px] text-amber-600 dark:text-amber-300">
          <AlertTriangle size={13} className="mt-0.5 shrink-0" />
          <span className="break-all">{statusError}</span>
        </div>
      )}

      {/* 凭据表单（保存时整体替换） */}
      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        <label className="text-[11px] text-cream-faint">
          {t('tiktok.appId')}
          <input
            value={appId}
            onChange={(event) => setAppId(event.target.value)}
            className="mt-1 h-9 w-full rounded-lg border border-line bg-ink-800 px-3 text-[12px] text-cream outline-none focus:border-accent/50"
            placeholder="73xxxxxxxx"
            autoComplete="off"
          />
        </label>
        <label className="text-[11px] text-cream-faint">
          {t('tiktok.appSecret')}
          <input
            type="password"
            value={appSecret}
            onChange={(event) => setAppSecret(event.target.value)}
            className="mt-1 h-9 w-full rounded-lg border border-line bg-ink-800 px-3 text-[12px] text-cream outline-none focus:border-accent/50"
            autoComplete="off"
          />
        </label>
        <label className="text-[11px] text-cream-faint sm:col-span-2">
          {t('tiktok.accessToken')}
          <input
            type="password"
            value={accessToken}
            onChange={(event) => setAccessToken(event.target.value)}
            className="mt-1 h-9 w-full rounded-lg border border-line bg-ink-800 px-3 text-[12px] text-cream outline-none focus:border-accent/50"
            placeholder={info.configured ? t('tiktok.accessTokenKeep') : ''}
            autoComplete="off"
          />
        </label>
        <label className="text-[11px] text-cream-faint sm:col-span-2">
          {t('tiktok.advertiserIds')}
          <input
            value={advertiserIds}
            onChange={(event) => setAdvertiserIds(event.target.value)}
            className="mt-1 h-9 w-full rounded-lg border border-line bg-ink-800 px-3 text-[12px] text-cream outline-none focus:border-accent/50"
            placeholder="7300000000000000000, 7311111111111111111"
            autoComplete="off"
          />
        </label>
      </div>

      {saveError && <p className="mt-2 break-all text-[11px] text-red-500">{saveError}</p>}

      <div className="mt-4 flex flex-wrap items-center gap-3">
        <button
          onClick={() => void save()}
          disabled={saveBusy || !canSave}
          className="flex items-center gap-1.5 rounded-lg bg-accent px-4 py-2 text-[12px] font-medium text-white shadow-card hover:bg-accent-bright disabled:opacity-50"
        >
          {saveBusy ? <LoaderCircle size={13} className="animate-spin" /> : <CheckCircle2 size={13} />}
          {t('tiktok.save')}
        </button>
        <button
          onClick={() => void refreshNow()}
          disabled={refreshBusy || !status.configured || status.refreshing}
          className="flex items-center gap-1.5 rounded-full border border-line px-3 py-1.5 text-[12px] text-cream-dim hover:text-cream disabled:opacity-50"
        >
          {refreshBusy || status.refreshing ? <LoaderCircle size={12} className="animate-spin" /> : <RefreshCw size={12} />}
          {t('tiktok.refreshNow')}
        </button>
        <label className="flex cursor-pointer select-none items-center gap-2 text-[12px] text-cream-dim">
          <input
            type="checkbox"
            checked={status.autoRefresh}
            onChange={() => void toggleAutoRefresh()}
            disabled={!status.configured}
            className="h-3.5 w-3.5 accent-[var(--accent)] disabled:opacity-40"
          />
          {t('tiktok.autoRefresh')}
        </label>
        {refreshResult === 'ok' && <span className="text-[11px] text-emerald-600 dark:text-emerald-400">{t('tiktok.refreshOk')}</span>}
        {refreshResult === 'fail' && <span className="text-[11px] text-red-500">{t('tiktok.refreshFail')}</span>}
      </div>

      {status.autoRefresh && (
        <div className="mt-3 flex items-center gap-2 text-[11px] text-cream-faint">
          <span className="rounded-full bg-emerald-500/12 px-2 py-0.5 text-[10px] font-medium text-emerald-600 dark:text-emerald-400">
            {t('tiktok.autoOn')}
          </span>
          <button onClick={() => void disconnect()} className="flex items-center gap-1 rounded-full border border-red-500/20 px-2 py-0.5 text-[10px] text-red-500 hover:bg-red-500/10">
            <Unplug size={10} /> {t('tiktok.autoCancel')}
          </button>
        </div>
      )}

      <p className="mt-4 flex items-start gap-1.5 text-[11px] leading-4 text-cream-faint">
        <LockKeyhole size={12} className="mt-0.5 shrink-0" />
        {t('tiktok.secureNote')}
      </p>
    </section>
  )
}
