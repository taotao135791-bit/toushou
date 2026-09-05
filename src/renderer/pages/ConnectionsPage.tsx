import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import QRCode from 'qrcode'
import { ArrowUpRight, Check, CheckCircle2, Link2, LockKeyhole, MessageCircle, QrCode, RefreshCw, Unplug } from 'lucide-react'
import { FeishuCapability, FeishuConnectionSnapshot, FeishuOAuthAuthorizationView, FeishuRegistrationView } from '@shared/connections'
import { useAppStore } from '../store'
import { useT } from '../i18n'

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

  const beginOAuth = async () => {
    setOauthBusy(true)
    const result = await window.electronAPI.feishuBeginOAuth(oauthCapability)
    setSnapshot(result.snapshot)
    if (result.ok) setOauthAuthorization(result.authorization)
    setOauthBusy(false)
  }

  const pollOAuth = async () => {
    setOauthBusy(true)
    const next = await window.electronAPI.feishuPollOAuth()
    setSnapshot(next)
    if (next.authorizedCapabilities.includes(oauthCapability)) setOauthAuthorization(null)
    setOauthBusy(false)
  }

  const isWaiting = snapshot.state === 'waiting_for_scan'
  const isConfiguring = ['registration_confirmed', 'storing_credentials', 'configuring_app', 'starting_channel', 'probing'].includes(snapshot.state)
  const isFailed = snapshot.status === 'failed'
  const isDegraded = snapshot.status === 'degraded'
  // The live websocket wins over the connect-state machine: during an SDK
  // self-reconnect the state field can lag while the channel is actually up.
  const isLive = snapshot.connected || snapshot.websocketState === 'connected'

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
      <div className="flex-1 overflow-y-auto p-5">
        <div className="mx-auto max-w-[720px] space-y-5">
          <div>
            <h1 className="text-xl font-semibold tracking-tight text-cream">{t('connections.title')}</h1>
            <p className="mt-1 text-[13px] text-cream-faint">{t('connections.subtitle')}</p>
          </div>

          <section className="overflow-hidden rounded-[18px] border border-line bg-ink-850 shadow-card">
            <div className="flex items-start justify-between gap-4 border-b border-line px-5 py-4">
              <div className="flex min-w-0 items-center gap-3">
                <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-[#3370ff] text-[20px] font-semibold text-white shadow-card">飞</div>
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <h2 className="text-[15px] font-semibold text-cream">{t('connections.feishu')}</h2>
                    <span className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${isLive ? 'bg-emerald-500/12 text-emerald-600 dark:text-emerald-400' : 'bg-overlay text-cream-faint'}`}>
                      {isLive ? t('connections.connected') : t('connections.notConnected')}
                    </span>
                  </div>
                  <p className="mt-1 max-w-[520px] text-[12px] leading-5 text-cream-faint">{t('connections.feishuDescription')}</p>
                </div>
              </div>
              <Link2 size={17} className="mt-1 shrink-0 text-cream-faint" />
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
                  <button onClick={() => void begin()} disabled={busy} className="flex items-center gap-2 rounded-full bg-accent px-4 py-2 text-[12px] font-medium text-white shadow-card hover:bg-accent-bright disabled:opacity-50">
                    <QrCode size={14} /> {t('connections.connect')}
                  </button>
                  <button onClick={() => setShowAdvanced(true)} className="text-[12px] text-cream-faint underline decoration-line-strong underline-offset-4 hover:text-cream">{t('connections.advanced')}</button>
                </div>
                <div className="mt-4 flex items-center gap-2 text-[11px] text-cream-faint"><LockKeyhole size={12} />{t('connections.secureNote')}</div>
              </div>
            )}

            {isWaiting && (
              <div className="flex flex-col items-center px-5 py-6">
                <div className="mb-4 flex items-center gap-2 text-[14px] font-medium text-cream"><QrCode size={16} className="text-accent" />{t('connections.scanTitle')}</div>
                {qrData ? <img src={qrData} alt={t('connections.scanTitle')} className="h-64 w-64 rounded-xl border border-line bg-white p-2" /> : <div className="h-64 w-64 animate-pulse rounded-xl bg-overlay" />}
                <p className="mt-4 text-[12px] text-cream-dim">{t('connections.scanHint')}</p>
                <p className="mt-1 text-[12px] text-amber-600 dark:text-amber-300">{t('connections.waiting')}</p>
                <div className="mt-4 flex flex-wrap justify-center gap-3">
                  <button onClick={() => registration && void window.electronAPI.feishuOpenUrl(registration.verificationUriComplete)} className="flex items-center gap-1.5 rounded-full border border-line px-3 py-1.5 text-[12px] text-cream-dim hover:text-cream"><ArrowUpRight size={12} />{t('connections.openLink')}</button>
                  <button onClick={() => void begin()} disabled={busy} className="flex items-center gap-1.5 rounded-full border border-line px-3 py-1.5 text-[12px] text-cream-dim hover:text-cream"><RefreshCw size={12} />{t('connections.regenerate')}</button>
                  <button onClick={() => void cancel()} disabled={busy} className="rounded-full px-3 py-1.5 text-[12px] text-cream-faint hover:text-cream">{t('connections.cancel')}</button>
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
              <div className="px-5 py-5">
                <div className="mb-4 flex items-center gap-2 text-[13px] font-medium text-emerald-600 dark:text-emerald-400"><CheckCircle2 size={16} />{t('connections.connectedHint')}</div>
                <div className="grid gap-2 sm:grid-cols-2">
                  <InfoRow label={t('connections.account')} value={snapshot.appIdMasked ?? '—'} />
                  <InfoRow label={t('connections.bot')} value={snapshot.botName ?? t('connections.defaultBot')} />
                  <InfoRow label={t('connections.messages')} value={t('connections.connected')} good />
                  <InfoRow label={t('connections.docs')} value={t('connections.onDemand')} />
                </div>
                <div className="mt-5 flex flex-wrap items-center gap-3">
                  <button onClick={tryInChat} className="flex items-center gap-1.5 rounded-full bg-accent px-3 py-1.5 text-[12px] font-medium text-white hover:bg-accent-bright"><MessageCircle size={12} />{t('connections.tryInChat')}</button>
                  <button onClick={() => void testConnection()} className="flex items-center gap-1.5 rounded-full border border-line px-3 py-1.5 text-[12px] text-cream-dim hover:text-cream"><RefreshCw size={12} />{checked ? t('connections.checked') : t('connections.check')}</button>
                  <button onClick={() => void disconnect()} disabled={busy} className="flex items-center gap-1.5 rounded-full border border-red-500/20 px-3 py-1.5 text-[12px] text-red-500 hover:bg-red-500/10"><Unplug size={12} />{t('connections.disconnect')}</button>
                </div>
                <div className="mt-5 border-t border-line pt-4">
                  <div className="text-[12px] font-medium text-cream">{t('connections.extraAccess')}</div>
                  <p className="mt-1 text-[11px] leading-5 text-cream-faint">{t('connections.extraAccessHint')}</p>
                  <div className="mt-3 flex flex-wrap items-center gap-2">
                    <select value={oauthCapability} onChange={(event) => setOauthCapability(event.target.value as FeishuCapability)} className="h-8 rounded-lg border border-line bg-ink-800 px-2 text-[11px] text-cream">
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
                      <button onClick={() => void beginOAuth()} disabled={oauthBusy} className="rounded-full border border-line px-3 py-1.5 text-[11px] text-cream-dim hover:text-cream disabled:opacity-50">{t('connections.authorize')}</button>
                    )}
                  </div>
                  {oauthAuthorization && (
                    <div className="mt-3 flex flex-wrap items-center gap-2 rounded-xl bg-overlay px-3 py-2.5 text-[11px] text-cream-dim">
                      <span>{t('connections.authorizationWaiting')}</span>
                      <button onClick={() => void window.electronAPI.feishuOpenUrl(oauthAuthorization.verificationUriComplete)} className="underline underline-offset-2 hover:text-cream">{t('connections.openLink')}</button>
                      <button onClick={() => void pollOAuth()} disabled={oauthBusy} className="rounded-full bg-accent px-2.5 py-1 text-white disabled:opacity-50">{t('connections.checkAuthorization')}</button>
                      <button onClick={() => { setOauthAuthorization(null); void window.electronAPI.feishuCancelOAuth() }} className="text-cream-faint hover:text-cream">{t('connections.cancel')}</button>
                    </div>
                  )}
                </div>
              </div>
            )}

            {isDegraded && (
              <div className="px-5 py-5"><div className="text-[13px] font-medium text-amber-600 dark:text-amber-300">{t('connections.degraded')}</div><p className="mt-1 text-[12px] text-cream-faint">{snapshot.lastError || t('connections.degradedHint')}</p><button onClick={() => void begin()} className="mt-4 flex items-center gap-1.5 rounded-full bg-accent px-3 py-1.5 text-[12px] font-medium text-white"><RefreshCw size={12} />{t('connections.retry')}</button></div>
            )}

            {isFailed && !showAdvanced && (
              <div className="px-5 py-5"><div className="text-[13px] font-medium text-red-500">{t('connections.error')}</div><p className="mt-1 text-[12px] text-cream-faint">{snapshot.lastError || t('connections.errorHint')}</p><div className="mt-4 flex gap-3"><button onClick={() => void begin()} className="flex items-center gap-1.5 rounded-full bg-accent px-3 py-1.5 text-[12px] font-medium text-white"><RefreshCw size={12} />{t('connections.retry')}</button><button onClick={() => setShowAdvanced(true)} className="rounded-full border border-line px-3 py-1.5 text-[12px] text-cream-dim">{t('connections.advanced')}</button></div></div>
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
                <div className="mt-4 flex flex-wrap gap-3"><button onClick={() => void connectManual()} disabled={busy || !appId || !appSecret} className="rounded-full bg-accent px-4 py-2 text-[12px] font-medium text-white disabled:opacity-50">{t('connections.saveAdvanced')}</button><button onClick={() => setShowAdvanced(false)} className="rounded-full border border-line px-3 py-1.5 text-[12px] text-cream-dim">{t('connections.hideAdvanced')}</button></div>
                <div className="mt-4 flex items-center gap-2 text-[11px] text-cream-faint"><LockKeyhole size={12} />{t('connections.secureNote')}</div>
              </div>
            )}
          </section>
        </div>
      </div>
    </div>
  )
}

function InfoRow({ label, value, good }: { label: string; value: string; good?: boolean }) {
  return <div className="flex items-center justify-between rounded-xl bg-overlay px-3 py-2.5 text-[12px]"><span className="text-cream-faint">{label}</span><span className={good ? 'font-medium text-emerald-600 dark:text-emerald-400' : 'max-w-[210px] truncate text-cream-dim'}>{value}</span></div>
}
