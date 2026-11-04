import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import QRCode from 'qrcode'
import { AlertTriangle, ArrowUpRight, Check, CheckCircle2, LoaderCircle, LockKeyhole, MessageCircle, QrCode, RefreshCw, Unplug } from 'lucide-react'
import { FeishuCapability, FeishuConnectionSnapshot, FeishuOAuthAuthorizationView, FeishuRegistrationView , FEISHU_CAPABILITY_SCOPES } from '@shared/connections'
import { useAppStore } from '../store'
import { useT, I18nKey } from '../i18n'
import McpConnectionsSection from '../components/McpConnectionsSection'
import AdsCopyModelsSection from '../components/AdsCopyModelsSection'
import TikTokAdsConnectionCard from '../components/TikTokAdsConnectionCard'
import AppsFlyerConnectionCard from '../components/AppsFlyerConnectionCard'
import FigmaConnectionCard from '../components/FigmaConnectionCard'
import BrandIcon from '../components/BrandIcon'

const emptySnapshot: FeishuConnectionSnapshot = {
  definition: {
    id: 'feishu',
    kind: 'channel',
    label: '飞书',
    description: '',
    capabilities: ['messaging']
  },
  status: 'disconnected',
  state: 'idle',
  connected: false,
  authorizedCapabilities: ['messaging']
}

export default function ConnectionsPage() {
  const t = useT()
  const navigate = useNavigate()
  const [snapshot, setSnapshot] = useState<FeishuConnectionSnapshot>(emptySnapshot)
  const [registration, setRegistration] = useState<FeishuRegistrationView | null>(null)
  const [qrData, setQrData] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [showAdvanced, setShowAdvanced] = useState(false)
  const [appId, setAppId] = useState('')
  const [appSecret, setAppSecret] = useState('')
  const [brand, setBrand] = useState<'feishu' | 'lark'>('feishu')
  const [checked, setChecked] = useState(false)
  const [oauthCapability, setOauthCapability] = useState<FeishuCapability>('docs.read')
  const [oauthAuthorization, setOauthAuthorization] = useState<FeishuOAuthAuthorizationView | null>(null)
  const [oauthError, setOauthError] = useState<string | null>(null)
  const [oauthBusy, setOauthBusy] = useState(false)

  useEffect(() => {
    let active = true
    void window.electronAPI.feishuStatus().then((value) => {
      if (active) setSnapshot(value)
    })
    const unsubscribe = window.electronAPI.onFeishuStatus((value) => {
      if (active) setSnapshot(value)
    })
    // Defensive poll while the page is open: a missed broadcast (fast startup
    // transition before the subscription lands) self-heals within seconds.
    const poll = setInterval(() => {
      void window.electronAPI.feishuStatus().then((value) => {
        if (active) setSnapshot(value)
      })
    }, 5_000)
    return () => {
      active = false
      unsubscribe()
      clearInterval(poll)
    }
  }, [])

  useEffect(() => {
    if (!registration?.verificationUriComplete) {
      setQrData(null)
      return
    }
    let active = true
    void QRCode.toDataURL(registration.verificationUriComplete, {
      margin: 2,
      width: 256,
      color: { dark: '#201d1a', light: '#fffdfa' }
    }).then((data) => {
      if (active) setQrData(data)
    })
    return () => {
      active = false
    }
  }, [registration])

  const begin = async () => {
    setBusy(true)
    setChecked(false)
    const result = await window.electronAPI.feishuBeginConnection(brand)
    setSnapshot(result.snapshot)
    if (result.ok) {
      setRegistration(result.registration ?? null)
      setShowAdvanced(false)
    } else {
      setRegistration(null)
      setShowAdvanced(true)
    }
    setBusy(false)
  }

  const cancel = async () => {
    setBusy(true)
    setRegistration(null)
    setSnapshot(await window.electronAPI.feishuCancelConnection())
    setBusy(false)
  }

  // 更新模式扫码：确认页预填缺失权限，确认后 Main 自动打开授权页续走一键授权。
  const beginRepair = async () => {
    setBusy(true)
    setChecked(false)
    const result = await window.electronAPI.feishuBeginRepair()
    setSnapshot(result.snapshot)
    if (result.ok) setRegistration(result.registration ?? null)
    setBusy(false)
  }

  const connectManual = async () => {
    setBusy(true)
    const result = await window.electronAPI.feishuConnectManual({ appId, appSecret, brand })
    setSnapshot(result.snapshot)
    setAppSecret('')
    if (result.ok) {
      setShowAdvanced(false)
      setAppId('')
    }
    setBusy(false)
  }

  const disconnect = async () => {
    setBusy(true)
    setRegistration(null)
    setSnapshot(await window.electronAPI.feishuDisconnect())
    setBusy(false)
  }

  const testConnection = async () => {
    setChecked(false)
    setSnapshot(await window.electronAPI.feishuStatus())
    setChecked(true)
  }

  const beginOAuth = async (capability: FeishuCapability | 'all' = oauthCapability) => {
    setOauthBusy(true)
    setOauthError(null)
    const result = await window.electronAPI.feishuBeginOAuth(capability)
    setSnapshot(result.snapshot)
    if (!result.ok) {
      setOauthError(result.error)
      setOauthBusy(false)
      return
    }
    setOauthAuthorization(result.authorization)
    // 真跳转：授权页立刻在浏览器打开，用户只需在网页上确认。
    void window.electronAPI.feishuOpenUrl(result.authorization.verificationUriComplete)
    // 自动等待授权结果（主进程轮询设备码直到成功/超时），期间界面保持可读状态。
    const next = await window.electronAPI.feishuPollOAuth()
    setSnapshot(next)
    setOauthAuthorization(null)
    if (capability !== 'all' && !next.authorizedCapabilities.includes(capability)) {
      setOauthError(t('connections.authorizationFailed'))
    }
    setOauthBusy(false)
  }

  const verifyScopes = async () => {
    setOauthBusy(true)
    const next = await window.electronAPI.feishuVerifyScopes()
    setSnapshot(next)
    setOauthBusy(false)
  }

  const isWaiting = snapshot.state === 'waiting_for_scan'
  const isRepairScan = snapshot.registrationMode === 'repair'
  const isConfiguring = ['registration_confirmed', 'storing_credentials', 'configuring_app', 'starting_channel', 'probing'].includes(snapshot.state)
  const isFailed = snapshot.status === 'failed'
  const isDegraded = snapshot.status === 'degraded'
  // The live websocket wins over the connect-state machine: during an SDK
  // self-reconnect the state field can lag while the channel is actually up.
  const isLive = snapshot.connected || snapshot.websocketState === 'connected'
  // Scopes the Feishu app console has not configured (requested but the
  // consent page refuses to grant) — drives the gap-guidance panel.
  const missingScopes = (
    Object.entries(FEISHU_CAPABILITY_SCOPES) as [FeishuCapability, { scope: string; label: string }][]
  ).filter(([capability]) => !snapshot.authorizedCapabilities.includes(capability))
  const capabilityLabel: Record<FeishuCapability, I18nKey> = {
    'docs.read': 'connections.scopeDocsRead',
    'docs.write': 'connections.scopeDocsWrite',
    'drive': 'connections.scopeDrive',
    'sheets.read': 'connections.scopeSheetsRead',
    'sheets.write': 'connections.scopeSheetsWrite',
    'bitable.read': 'connections.scopeBitableRead',
    'bitable.write': 'connections.scopeBitableWrite',
    'calendar.read': 'connections.scopeCalendarRead',
    'calendar.write': 'connections.scopeCalendarWrite',
    'tasks': 'connections.scopeTasks',
    'search': 'connections.scopeSearch',
    'messaging': 'connections.scopeDocsRead'
  }

  const tryInChat = () => {
    const store = useAppStore.getState()
    store.setCurrentSessionId(null)
    store.setComposerPrefill(t('connections.tryPrompt'))
    navigate('/')
  }

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <header className="app-drag flex h-12 shrink-0 items-center border-b border-line px-4">
        <span className="text-[13px] font-medium text-cream">{t('connections.title')}</span>
      </header>
      <div className="flex-1 overflow-y-auto px-4 py-6 sm:px-6">
        <div className="mx-auto max-w-[760px] space-y-4">
          {/* One title only (design.md 3.3): the topbar owns the page name,
              the content keeps just the intro line. */}
          <p className="pb-1 text-[13px] leading-5 text-cream-dim">{t('connections.subtitle')}</p>

          <section className="overflow-hidden rounded-2xl border border-line bg-ink-850" aria-labelledby="feishu-connection-heading">
            <div className="px-5 pt-5">
              <div className="flex min-w-0 items-center gap-3">
                <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-overlay"><BrandIcon brand="feishu" size={32} /></div>
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <h2 id="feishu-connection-heading" className="text-[15px] font-semibold text-cream">{t('connections.feishu')}</h2>
                    <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${isLive ? 'bg-emerald-500/12 text-emerald-700 dark:text-emerald-400' : 'bg-overlay text-cream-faint'}`}>
                      {isLive ? t('connections.connected') : t('connections.notConnected')}
                    </span>
                  </div>
                </div>
              </div>
              <p className="mt-3 max-w-[560px] text-[12px] leading-5 text-cream-dim">{t('connections.feishuDescription')}</p>
            </div>

            {!isLive && !isWaiting && !isConfiguring && !showAdvanced && (
              <div className="px-5 py-5">
                <div className="grid gap-2.5 text-[12px] text-cream-dim sm:grid-cols-3">
                  {[t('connections.benefitChat'), t('connections.benefitGroup'), t('connections.benefitDocs')].map((text) => (
                    <div key={text} className="flex items-start gap-2 rounded-xl bg-overlay px-3 py-2.5">
                      <Check size={13} className="mt-0.5 shrink-0 text-accent" />
                      <span>{text}</span>
                    </div>
                  ))}
                </div>
                <div className="mt-5 flex flex-wrap items-center gap-3">
                  <button onClick={() => void begin()} disabled={busy} className="min-h-8 focus-ring flex items-center gap-2 rounded-lg bg-accent px-4 py-2 text-[12px] font-medium text-[rgb(var(--bg-app))] hover:bg-accent-bright disabled:opacity-50">
                    <QrCode size={14} /> {t('connections.connect')}
                  </button>
                  <button onClick={() => setShowAdvanced(true)} className="min-h-8 focus-ring text-[12px] text-cream-faint underline decoration-line-strong underline-offset-4 hover:text-cream">{t('connections.advanced')}</button>
                </div>
                <div className="mt-4 flex items-center gap-2 text-[11px] text-cream-faint"><LockKeyhole size={12} />{t('connections.secureNote')}</div>
              </div>
            )}

            {isWaiting && (
              <div className="flex flex-col items-center px-5 py-6">
                <div className="mb-4 flex items-center gap-2 text-[14px] font-medium text-cream"><QrCode size={16} className="text-accent" />{isRepairScan ? t('connections.repairScanTitle') : t('connections.scanTitle')}</div>
                {qrData ? <img src={qrData} alt={t('connections.scanTitle')} className="h-64 w-64 rounded-xl border border-line bg-white p-2" /> : <div className="h-64 w-64 animate-pulse rounded-xl bg-overlay" />}
                <p className="mt-4 text-[12px] text-cream-dim">{isRepairScan ? t('connections.repairScanHint') : t('connections.scanHint')}</p>
                <p className="mt-1 text-[12px] text-amber-600 dark:text-amber-300">{t('connections.waiting')}</p>
                <div className="mt-4 flex flex-wrap justify-center gap-3">
                  <button onClick={() => registration && void window.electronAPI.feishuOpenUrl(registration.verificationUriComplete)} className="min-h-8 focus-ring flex items-center gap-1.5 rounded-lg border border-line px-3 py-1.5 text-[12px] text-cream-dim hover:text-cream"><ArrowUpRight size={12} />{t('connections.openLink')}</button>
                  <button onClick={() => void begin()} disabled={busy} className="min-h-8 focus-ring flex items-center gap-1.5 rounded-lg border border-line px-3 py-1.5 text-[12px] text-cream-dim hover:text-cream"><RefreshCw size={12} />{t('connections.regenerate')}</button>
                  <button onClick={() => void cancel()} disabled={busy} className="min-h-8 focus-ring rounded-lg px-3 py-1.5 text-[12px] text-cream-faint hover:text-cream">{t('connections.cancel')}</button>
                </div>
                <p className="mt-4 text-[11px] text-cream-faint">{t('connections.expires')}</p>
              </div>
            )}

            {isConfiguring && (
              <div className="px-5 py-7">
                <div className="flex items-center gap-3"><RefreshCw size={18} className="animate-spin text-accent" /><div><div className="text-[14px] font-medium text-cream">{t('connections.configuring')}</div><div className="mt-1 text-[12px] text-cream-faint">{t('connections.configuringHint')}</div></div></div>
              </div>
            )}

            {isLive && (
              <div className="px-5 pb-5 pt-4">
                <div role="status" className="flex items-center gap-2 text-[13px] font-medium text-emerald-700 dark:text-emerald-400"><CheckCircle2 size={16} className="shrink-0" />{t('connections.connectedHint')}</div>
                <div className="mt-3 flex flex-wrap items-center gap-2">
                  <button onClick={tryInChat} className="min-h-8 focus-ring flex items-center gap-1.5 rounded-lg bg-accent px-3 py-1.5 text-[12px] font-medium text-[rgb(var(--bg-app))] hover:bg-accent-bright"><MessageCircle size={12} />{t('connections.tryInChat')}</button>
                  <button onClick={() => void testConnection()} className="min-h-8 focus-ring flex items-center gap-1.5 rounded-lg border border-line px-3 py-1.5 text-[12px] text-cream-dim hover:text-cream"><RefreshCw size={12} />{checked ? t('connections.checked') : t('connections.check')}</button>
                  <button onClick={() => void disconnect()} disabled={busy} className="min-h-8 focus-ring flex items-center gap-1.5 rounded-lg border border-red-500/20 px-3 py-1.5 text-[12px] text-red-500 hover:bg-red-500/10"><Unplug size={12} />{t('connections.disconnect')}</button>
                </div>
                {snapshot.consoleAuthUrl && missingScopes.length > 0 && <div role="status" className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-xl bg-amber-500/10 px-3 py-3">
                  <div className="flex min-w-0 items-center gap-2 text-[12px] text-amber-800 dark:text-amber-300"><AlertTriangle size={14} className="shrink-0" /><span>{t('connections.scopeGapTitle', { count: missingScopes.length })}</span></div>
                  <button type="button" onClick={() => void beginRepair()} disabled={busy} className="focus-ring min-h-8 shrink-0 rounded-lg border border-amber-500/30 px-3 py-1.5 text-[12px] font-medium text-amber-800 hover:bg-amber-500/10 disabled:opacity-50 dark:text-amber-300">{t('connections.scopeGapRepair')}</button>
                </div>}
                <details className="mt-4 border-t border-line pt-3">
                  <summary className="focus-ring w-fit cursor-pointer rounded text-[12px] leading-5 text-cream-dim hover:text-cream">{t('connections.tiktokDetails')}</summary>
                  <div className="mt-3 grid gap-2 sm:grid-cols-2">
                    <InfoRow label={t('connections.account')} value={snapshot.appIdMasked ?? '—'} />
                    <InfoRow label={t('connections.bot')} value={snapshot.botName ?? t('connections.defaultBot')} />
                    <InfoRow label={t('connections.messages')} value={t('connections.connected')} good />
                    <InfoRow label={t('connections.docs')} value={t('connections.onDemand')} />
                  </div>
                </details>
                <details className="mt-3 border-t border-line pt-3">
                  <summary className="focus-ring w-fit cursor-pointer rounded text-[12px] leading-5 text-cream-dim hover:text-cream">{t('connections.extraAccess')}</summary>
                  <div className="pt-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="flex flex-wrap gap-2">
                      <button onClick={() => void beginOAuth('all')} disabled={oauthBusy} className="min-h-8 focus-ring rounded-lg bg-accent px-3 py-1.5 text-[11px] font-medium text-[rgb(var(--bg-app))] hover:bg-accent-bright disabled:opacity-50">{t('connections.authorizeAll')}</button>
                      <button onClick={() => void verifyScopes()} disabled={oauthBusy} className="min-h-8 focus-ring flex items-center gap-1 rounded-lg border border-line px-3 py-1.5 text-[11px] text-cream-dim hover:text-cream disabled:opacity-50"><RefreshCw size={11} />{t('connections.verifyScopes')}</button>
                    </div>
                  </div>
                  <p className="mt-1 text-[11px] leading-5 text-cream-faint">{t('connections.extraAccessHint')}</p>

                  {/* 权限核验清单：已授权 ✓ / 未授权 ○ */}
                  <div className="mt-3 flex flex-wrap gap-1.5">
                    {([
                      ['docs.read', 'connections.scopeDocsRead'],
                      ['docs.write', 'connections.scopeDocsWrite'],
                      ['drive', 'connections.scopeDrive'],
                      ['sheets.read', 'connections.scopeSheetsRead'],
                      ['sheets.write', 'connections.scopeSheetsWrite'],
                      ['bitable.read', 'connections.scopeBitableRead'],
                      ['bitable.write', 'connections.scopeBitableWrite'],
                      ['calendar.read', 'connections.scopeCalendarRead'],
                      ['calendar.write', 'connections.scopeCalendarWrite'],
                      ['tasks', 'connections.scopeTasks']
                    ] as [FeishuCapability, I18nKey][]).map(([capability, key]) => {
                      const granted = snapshot.authorizedCapabilities.includes(capability)
                      return (
                        <span
                          key={capability}
                          className={`flex items-center gap-1 rounded-full px-2 py-0.5 text-[10.5px] ${
                            granted
                              ? 'bg-emerald-500/12 text-emerald-600 dark:text-emerald-400'
                              : 'bg-overlay text-cream-faint'
                          }`}
                        >
                          {granted ? <Check size={10} /> : <span className="inline-block h-[6px] w-[6px] rounded-full border border-current opacity-60" />}
                          {t(key)}
                        </span>
                      )
                    })}
                  </div>

                  {/* Permission-gap guidance: scopes the Feishu app console has
                      NOT configured — enable + publish a version there, then
                      re-verify here. The console deep link is built Main-side. */}
                  {snapshot.consoleAuthUrl && missingScopes.length > 0 && (
                    <div className="mt-3 rounded-xl border border-amber-500/30 bg-amber-500/8 p-3">
                      <div className="flex items-center gap-1.5 text-[12px] font-medium text-amber-600 dark:text-amber-400">
                        <AlertTriangle size={12} />
                        {t('connections.scopeGapTitle', { count: missingScopes.length })}
                      </div>
                      <ul className="mt-2 space-y-1">
                        {missingScopes.map(([capability, meta]) => (
                          <li key={capability} className="flex min-w-0 items-center gap-2 text-[11px] text-cream-faint">
                            <span className="shrink-0 text-cream-dim">{t(capabilityLabel[capability])}</span>
                            <code className="truncate font-mono text-[10px]">{meta.scope}</code>
                          </li>
                        ))}
                      </ul>
                      <div className="mt-2 flex flex-wrap gap-2">
                        <button
                          onClick={() => void beginRepair()}
                          disabled={busy}
                          className="min-h-8 focus-ring rounded-lg bg-accent px-3 py-1 text-[11px] font-medium text-[rgb(var(--bg-app))] transition hover:bg-accent-bright disabled:opacity-50"
                        >
                          {t('connections.scopeGapRepair')}
                        </button>
                        <button
                          onClick={() => void navigator.clipboard.writeText(missingScopes.map(([, meta]) => meta.scope).join('\n'))}
                          className="min-h-8 focus-ring rounded-lg border border-line px-3 py-1 text-[11px] text-cream-dim transition hover:text-cream"
                        >
                          {t('connections.scopeGapCopy')}
                        </button>
                        <button
                          onClick={() => void window.electronAPI.openExternalUrl(snapshot.consoleAuthUrl!)}
                          className="min-h-8 focus-ring rounded-lg border border-line px-3 py-1 text-[11px] text-cream-dim transition hover:text-cream"
                        >
                          {t('connections.scopeGapOpenConsole')}
                        </button>
                      </div>
                      <p className="mt-1.5 text-[10.5px] leading-4 text-cream-faint/70">
                        {t('connections.scopeGapHint')}
                      </p>
                    </div>
                  )}

                  <div className="mt-3 flex flex-wrap items-center gap-2">
                    <select aria-label={t('connections.extraAccess')} value={oauthCapability} onChange={(event) => setOauthCapability(event.target.value as FeishuCapability)} className="focus-ring h-8 max-w-full rounded-lg border border-line bg-ink-800 px-2 text-[12px] text-cream">
                      <option value="docs.read">{t('connections.scopeDocsRead')}</option>
                      <option value="docs.write">{t('connections.scopeDocsWrite')}</option>
                      <option value="drive">{t('connections.scopeDrive')}</option>
                      <option value="sheets.read">{t('connections.scopeSheetsRead')}</option>
                      <option value="sheets.write">{t('connections.scopeSheetsWrite')}</option>
                      <option value="bitable.read">{t('connections.scopeBitableRead')}</option>
                      <option value="bitable.write">{t('connections.scopeBitableWrite')}</option>
                    </select>
                    {snapshot.authorizedCapabilities.includes(oauthCapability) ? (
                      <span className="text-[11px] text-emerald-600 dark:text-emerald-400">{t('connections.authorized')}</span>
                    ) : (
                      <button onClick={() => void beginOAuth()} disabled={oauthBusy} className="min-h-8 focus-ring rounded-lg border border-line px-3 py-1.5 text-[11px] text-cream-dim hover:text-cream disabled:opacity-50">{t('connections.authorize')}</button>
                    )}
                  </div>

                  </div>
                </details>
                  {oauthBusy && oauthAuthorization && (
                    <div className="mt-3 flex flex-wrap items-center gap-2 rounded-xl border border-accent/30 bg-accent/[0.07] px-3 py-2.5 text-[11px] text-cream-dim">
                      <LoaderCircle size={12} className="animate-spin text-accent" />
                      <span>{t('connections.authorizationAutoWaiting')}</span>
                      <button onClick={() => void window.electronAPI.feishuOpenUrl(oauthAuthorization.verificationUriComplete)} className="min-h-8 focus-ring underline underline-offset-2 hover:text-cream">{t('connections.openLink')}</button>
                      <button onClick={() => { setOauthAuthorization(null); void window.electronAPI.feishuCancelOAuth() }} className="min-h-8 focus-ring text-cream-faint hover:text-cream">{t('connections.cancel')}</button>
                    </div>
                  )}
                  {oauthError && <p className="mt-2 text-[11px] text-red-500">{oauthError}</p>}
              </div>
            )}

            {isDegraded && (
              <div className="px-5 py-5"><div className="text-[13px] font-medium text-amber-600 dark:text-amber-300">{t('connections.degraded')}</div><p className="mt-1 text-[12px] text-cream-faint">{snapshot.lastError || t('connections.degradedHint')}</p><button onClick={() => void begin()} className="min-h-8 focus-ring mt-4 flex items-center gap-1.5 rounded-lg bg-accent px-3 py-1.5 text-[12px] font-medium text-[rgb(var(--bg-app))]"><RefreshCw size={12} />{t('connections.retry')}</button></div>
            )}

            {isFailed && !showAdvanced && (
              <div className="px-5 py-5"><div className="text-[13px] font-medium text-red-500">{t('connections.error')}</div><p className="mt-1 text-[12px] text-cream-faint">{snapshot.lastError || t('connections.errorHint')}</p><div className="mt-4 flex gap-3"><button onClick={() => void begin()} className="min-h-8 focus-ring flex items-center gap-1.5 rounded-lg bg-accent px-3 py-1.5 text-[12px] font-medium text-[rgb(var(--bg-app))]"><RefreshCw size={12} />{t('connections.retry')}</button><button onClick={() => setShowAdvanced(true)} className="min-h-8 focus-ring rounded-lg border border-line px-3 py-1.5 text-[12px] text-cream-dim">{t('connections.advanced')}</button></div></div>
            )}

            {showAdvanced && !isLive && (
              <div className="border-t border-line px-5 py-5">
                <div className="text-[13px] font-medium text-cream">{t('connections.advanced')}</div>
                <p className="mt-1 text-[11px] leading-5 text-cream-faint">{t('connections.advancedHint')}</p>
                <div className="mt-4 grid gap-3 sm:grid-cols-2">
                  <label className="text-[11px] text-cream-faint">{t('connections.appId')}<input value={appId} onChange={(event) => setAppId(event.target.value)} className="mt-1 h-9 w-full rounded-lg border border-line bg-ink-800 px-3 text-[12px] text-cream outline-none focus:border-accent/50" placeholder="cli_…" /></label>
                  <label className="text-[11px] text-cream-faint">{t('connections.appSecret')}<input type="password" value={appSecret} onChange={(event) => setAppSecret(event.target.value)} className="mt-1 h-9 w-full rounded-lg border border-line bg-ink-800 px-3 text-[12px] text-cream outline-none focus:border-accent/50" /></label>
                </div>
                <label className="mt-3 block text-[11px] text-cream-faint">{t('connections.brand')}<select value={brand} onChange={(event) => setBrand(event.target.value as 'feishu' | 'lark')} className="mt-1 h-9 rounded-lg border border-line bg-ink-800 px-3 text-[12px] text-cream outline-none"><option value="feishu">{t('connections.feishuRegion')}</option><option value="lark">{t('connections.larkRegion')}</option></select></label>
                {snapshot.lastError && <p className="mt-3 text-[11px] text-red-500">{snapshot.lastError}</p>}
                <div className="mt-4 flex flex-wrap gap-3"><button onClick={() => void connectManual()} disabled={busy || !appId || !appSecret} className="min-h-8 focus-ring rounded-lg bg-accent px-4 py-2 text-[12px] font-medium text-[rgb(var(--bg-app))] disabled:opacity-50">{t('connections.saveAdvanced')}</button><button onClick={() => setShowAdvanced(false)} className="min-h-8 focus-ring rounded-lg border border-line px-3 py-1.5 text-[12px] text-cream-dim">{t('connections.hideAdvanced')}</button></div>
                <div className="mt-4 flex items-center gap-2 text-[11px] text-cream-faint"><LockKeyhole size={12} />{t('connections.secureNote')}</div>
              </div>
            )}
          </section>

          <TikTokAdsConnectionCard />
          <AppsFlyerConnectionCard />
          <FigmaConnectionCard />
          <McpConnectionsSection />
          <AdsCopyModelsSection />
        </div>
      </div>
    </div>
  )
}

function InfoRow({ label, value, good }: { label: string; value: string; good?: boolean }) {
  return <dl className="flex min-w-0 items-start justify-between gap-3 rounded-lg bg-overlay px-3 py-2.5 text-[12px] leading-5"><dt className="shrink-0 text-cream-faint">{label}</dt><dd className={`min-w-0 break-words text-right ${good ? 'font-medium text-emerald-700 dark:text-emerald-400' : 'text-cream-dim'}`}>{value}</dd></dl>
}
