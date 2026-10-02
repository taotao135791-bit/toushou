import type { ReadingErrorCode } from '@shared/readingError'
import { useT, type I18nKey } from '../../i18n'

/** What the user can do about a failed reading; each maps to one button. */
export type ReadingNextStep =
  | 'retry'
  | 'connect'
  | 'reconnect'
  | 'pick-advertiser'
  | 'edit-module'
  | 'pick-account'
  | 'open-browser'

export interface ReadingNotice {
  message: string
  step: ReadingNextStep
}

type Translate = (key: I18nKey, vars?: Record<string, string | number>) => string

const STEP_LABEL: Record<ReadingNextStep, I18nKey> = {
  retry: 'boards.reading.action.retry',
  connect: 'boards.tt.goConnect',
  reconnect: 'boards.reading.action.reconnect',
  'pick-advertiser': 'boards.reading.action.pickAdvertiser',
  'edit-module': 'boards.reading.action.editModule',
  'pick-account': 'boards.reading.action.pickAccount',
  'open-browser': 'boards.today.openBrowser'
}

/** TikTok reading codes from Main, plus the renderer's own failed invoke. */
export function tiktokReadingNotice(code: ReadingErrorCode | 'invoke-failed', t: Translate): ReadingNotice {
  switch (code) {
    case 'no-credentials':
      return { message: t('boards.tt.noCredentials'), step: 'connect' }
    case 'no-advertiser':
      return { message: t('boards.tt.error.noAdvertiser'), step: 'pick-advertiser' }
    case 'auth':
      return { message: t('boards.tt.error.auth'), step: 'reconnect' }
    case 'permission':
      return { message: t('boards.tt.error.permission'), step: 'pick-advertiser' }
    case 'rate-limit':
      return { message: t('boards.tt.error.rateLimit'), step: 'retry' }
    case 'network':
      return { message: t('boards.tt.error.network'), step: 'retry' }
    case 'invalid-input':
      return { message: t('boards.tt.invalidAdvertisers'), step: 'edit-module' }
    default:
      return { message: t('boards.tt.error.api'), step: 'retry' }
  }
}

/** Facebook browser-pipeline codes (Main) — one table for every FB surface. */
export function fbReadingNotice(
  code: string,
  t: Translate,
  fallback: I18nKey = 'boards.reading.refreshFailed'
): ReadingNotice {
  if (code === 'login-required') return { message: t('boards.reading.error.login'), step: 'open-browser' }
  if (code === '2fa-required') return { message: t('boards.reading.balance.error.2fa'), step: 'open-browser' }
  if (code === 'panel-hidden' || code === 'panel-not-open') {
    return { message: t('boards.reading.error.closed'), step: 'open-browser' }
  }
  if (code === 'page-load-failed') return { message: t('boards.reading.error.page'), step: 'retry' }
  if (code.startsWith('ERR_') || code === 'navigation-timeout' || code === 'refresh-timeout') {
    return { message: t('boards.reading.error.network'), step: 'retry' }
  }
  if (code === 'date-mismatch') return { message: t('boards.reading.error.date'), step: 'retry' }
  if (code === 'browser-busy') return { message: t('boards.reading.error.busy'), step: 'retry' }
  if (code === 'invalid-input') return { message: t('boards.reading.error.unknownAccount'), step: 'pick-account' }
  return { message: t(fallback), step: 'retry' }
}

/**
 * Plain-words failure with one next step. The raw code/message stays behind
 * 技术细节 so a support thread can still quote it.
 */
export function ReadingErrorNotice({
  notice,
  detail,
  onAction,
  busy = false,
  className = ''
}: {
  notice: ReadingNotice
  detail?: string | null
  onAction?: (step: ReadingNextStep) => void
  busy?: boolean
  className?: string
}) {
  const t = useT()
  return (
    <div role="alert" className={`text-[12px] leading-[18px] ${className}`}>
      <p className="text-red-600 dark:text-red-400">{notice.message}</p>
      {(onAction || detail) && (
        <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1">
          {onAction && (
            <button
              type="button"
              onClick={() => onAction(notice.step)}
              disabled={busy}
              className="focus-ring rounded-full border border-line px-2.5 py-0.5 text-[12px] leading-[18px] text-cream transition hover:bg-overlay disabled:opacity-40"
            >
              {t(STEP_LABEL[notice.step])}
            </button>
          )}
          {detail && (
            <details className="min-w-0 text-cream-faint">
              <summary className="cursor-pointer select-none">{t('boards.reading.details')}</summary>
              <code className="mt-0.5 block break-all font-mono text-[12px] leading-[18px]">{detail}</code>
            </details>
          )}
        </div>
      )}
    </div>
  )
}
