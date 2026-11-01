import type { ReadingSnapshot, ReadingSnapshotAccount } from '@shared/readingSnapshot'
import { readingSnapshotHtmlChartGroups, resultTypeLabel } from '@shared/readingSnapshotHtml'

type Language = 'zh' | 'en'
export interface ReadingSnapshotChartGroup { platform: string; currency: string | null; window: ReadingSnapshotAccount['window']; timezone: string | null; timezoneGroup: number | null; rows: Array<{ index: number; account: ReadingSnapshotAccount }> }

/** Use the same comparison rules as offline exports. */
export function snapshotChartGroups(snapshot: ReadingSnapshot): ReadingSnapshotChartGroup[] {
  return readingSnapshotHtmlChartGroups(snapshot).map(({ entries, ...group }) => ({ ...group, rows: entries }))
}

const platform = (name: string) => name === 'facebook' ? 'Facebook' : name === 'tiktok' ? 'TikTok' : 'Google'
const label = (index: number, account: ReadingSnapshotAccount, language: Language, anonymous: boolean) =>
  anonymous ? `${language === 'zh' ? '账户' : 'Account'} ${index + 1}` : account.name || account.accountId || '—'
const amount = (value: number | null, places = 2) => value === null ? '—' : value.toLocaleString(undefined, { maximumFractionDigits: places })
const dates = (window: { start: string; end: string }) => `${window.start} – ${window.end}`
const stamp = (value: number | null) => value === null ? '—' : new Date(value).toLocaleString()
const status = (value: ReadingSnapshotAccount['status'], zh: boolean) => ({
  ok: zh ? '成功' : 'Read', failed: zh ? '失败' : 'Failed', unattempted: zh ? '未尝试' : 'Not attempted', unavailable: zh ? '不可用' : 'Unavailable'
})[value]

/** Plain HTML, with no scripts, embeds, external links, or dynamic HTML. */
export function ReadingSnapshotView({ snapshot, includeChart, language = 'zh', anonymous = false }: {
  snapshot: ReadingSnapshot; includeChart: boolean; language?: Language; anonymous?: boolean
}) {
  const zh = language === 'zh'
  const groups = includeChart ? snapshotChartGroups(snapshot) : []
  return <div className="reading-snapshot h-full overflow-auto text-[12px] text-cream">
    <p className="mb-2 text-cream-faint">{zh ? '已保存的读数快照，不会自动刷新' : 'Saved reading snapshot; it does not refresh automatically'}{!anonymous && <> · {snapshot.rangeLabel}</>} · {dates(snapshot.window)} · {zh ? '保存于' : 'Saved'} {stamp(snapshot.capturedAt)}</p>
    <div className="overflow-x-auto"><table className="w-full border-collapse text-left">
      <thead><tr>{(zh ? ['平台', '账户', '状态', '报告日期', '来源时间', '币种', '消耗', '上期消耗', '展示', '点击', '结果'] : ['Platform', 'Account', 'Status', 'Report dates', 'Source time', 'Currency', 'Spend', 'Prior spend', 'Impressions', 'Clicks', 'Results']).map(title => <th key={title} scope="col" className="border-b border-line px-2 py-1 font-medium">{title}</th>)}</tr></thead>
      <tbody>{snapshot.accounts.map((account, index) => <tr key={`${account.platform}-${index}`} data-reading-account-index={index + 1} tabIndex={-1}>
        <td className="border-b border-line px-2 py-1">{platform(account.platform)}</td>
        <td className="border-b border-line px-2 py-1"><span>{label(index, account, language, anonymous)}</span>{!anonymous && account.name && account.accountId && <span className="ml-1 text-cream-faint">({account.accountId})</span>}</td>
        <td className="border-b border-line px-2 py-1">{status(account.status, zh)}{!anonymous && account.statusDetail && <span className="block text-cream-faint">{account.statusDetail}</span>}</td>
        <td className="border-b border-line px-2 py-1 whitespace-nowrap">{dates(account.window)}{!anonymous && account.timezone ? ` · ${account.timezone}` : ''}{account.previousWindow && <span className="block text-cream-faint">{zh ? '上期' : 'Prior'} {dates(account.previousWindow)}</span>}</td>
        <td className="border-b border-line px-2 py-1 whitespace-nowrap">{stamp(account.sourceAt)}</td>
        <td className="border-b border-line px-2 py-1">{account.currency ?? (zh ? '未知' : 'Unknown')}</td>
        {[account.spend, account.previousSpend, account.impressions, account.clicks, account.conversions].map((value, i) => <td key={i} className="border-b border-line px-2 py-1 text-right tabular-nums">{amount(value)}{i === 4 && account.resultType && <span className="block text-cream-faint">{resultTypeLabel(account, anonymous, zh)}</span>}</td>)}
      </tr>)}</tbody>
    </table></div>
    {includeChart && <section className="mt-4" aria-label={zh ? '账户消耗图' : 'Account spend chart'}>
      <h3 className="font-semibold">{zh ? '账户消耗（按平台、币种、日期和时区分别展示）' : 'Account spend (separate platform, currency, date and timezone groups)'}</h3>
      {!groups.length && <p className="text-cream-faint">{zh ? '没有可绘制的成功读数。' : 'No successful readings to chart.'}</p>}
      {groups.map((group, groupIndex) => {
        const max = Math.max(...group.rows.map(row => row.account.spend ?? 0), 0)
        const timezone = group.timezone ? (anonymous ? `${zh ? '时区组' : 'Timezone group'} ${group.timezoneGroup}` : group.timezone) : (zh ? '时区未知（单账户）' : 'Timezone unknown (one account)')
        return <div key={`${group.platform}-${groupIndex}`} className="mt-3">
          <h4 className="font-medium">{platform(group.platform)} · {group.currency ?? (zh ? '币种未知（单账户）' : 'Currency unknown (one account)')} · {dates(group.window)} · {timezone}</h4>
          {group.rows.map(({ account, index }) => <div key={index} className="mt-1 grid grid-cols-[minmax(80px,1fr)_minmax(80px,3fr)_auto] items-center gap-2">
            <span className="truncate" title={label(index, account, language, anonymous)}>{label(index, account, language, anonymous)}</span>
            <span className="block h-3 rounded bg-cream/10"><span className="block h-3 rounded bg-accent" style={{ width: `${max > 0 ? Math.min(100, (account.spend ?? 0) / max * 100) : 0}%` }} /></span>
            <span className="tabular-nums">{amount(account.spend)}</span>
          </div>)}
        </div>
      })}
    </section>}
  </div>
}
