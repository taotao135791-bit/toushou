import { describe, expect, it } from 'vitest'
import {
  fbAdsReadingRejection,
  fbAdsReadingRowsMatchCount,
  fbAdsReadingTotalsMatch,
  fbAdsReadingsConsistent,
  mergeFbAdsCampaignReadings,
  parseFbAdsCampaignsSnapshot,
  parseFbMetricNumber
} from './fbAdsParser'

/**
 * REAL fixture — captured 2026-09-11 from the user's live Ads Manager
 * campaigns table (account COOPLAY-ADT-IOS-03, "leo 的列" preset, past-30-
 * days view) using the exact extraction the browser snapshot produces
 * (innerText of <main>). Numbers below must keep matching the page: spend
 * rows sum to the summary total exactly ($3,146.47).
 */
export const REAL_CAMPAIGNS_TEXT = `广告管理工具
​
48
账户概览
广告系列
广告报告
受众
广告设置
账单与支付
事件管理工具
所有工具
帮助
业务设置
​
搜索
​
报告问题
​
我们正在完善成效衡量方法
自 2026 年 3 月 17 日起，点击成效仅报告链接点击后产生的网站与店内转化（如购物），互动成效则报告所有其他广告操作后产生的此类转化。
关于本次更新
关闭
​
广告系列
COOPLAY-ADT-IOS-03 (2131017261144314)
21
机会分数
更新时间：刚刚
刷新表格数据
​
放弃草稿
检查并发布(3)
菜单
​
全部广告
正在投放的广告
投放过
Actions
查看更多
创建视图
设置
​
搜索以按如下条件筛选：名称、编号或指标
广告系列
广告组
广告
过去 30 天：2026年8月12日 – 2026年9月10日
创建
复制
编辑
A/B 测试
更多
列：leo 的列
细分条件
报告
​
导出
​
打开下拉菜单
​
对比
​
关/开
广告系列
已花费金额
单次应用安装费用
CPM（千次展示费用）
成效
点击量（全部）
点击率（全部）
单次点击费用（全部）
应用安装量
移动应用安装量
投放
操作
归因设置
单次成效费用
预算
定制列...
adtiger_三國點將令_IOS_aem_HK/TW/SG/MY_aeo_leo_0911_008
$0.00
—
—
—
应用内购买
—
—
—
—
adtiger_三國點將令_IOS_aem_HK/TW_aeo_leo_0908_007
$529.08
$22.05
$17.51
—
应用内购买
788
2.61%
$0.67
24
adtiger_三國點將令_IOS_aem_SG/MY_aeo_leo_0904_006
$315.50
$26.29
$17.10
—
应用内购买
467
2.53%
$0.68
12
adtiger_三國點將令_IOS_aem_TW_aeo_leo_0904_005
$318.60
$17.70
$18.18
—
应用内购买
478
2.73%
$0.67
18
adtiger_三國點將令_IOS_aem_HK_aeo_leo_0904_004
$332.11
$23.72
$23.19
1
应用内购买
363
2.53%
$0.91
14
adtiger_三國點將令_IOS_skan_MO/HK/TW_FB_aeo_leo_0901_003
$240.97
$34.42
$14.19
—
应用内购买
194
1.14%
$1.24
7
adtiger_三國點將令_IOS_MO/HK/TW_FB_aeo_Ricky_0827_001
$476.45
$36.65
$27.34
4
应用内购买
295
1.69%
$1.62
13
adtiger_三國點將令_IOS_MO/HK/TW_FB_aeo_Ricky_0825_001
$933.76
$15.31
$17.88
129
应用内购买
1,110
2.13%
$0.84
61
8个广告系列的成效
​
$3,146.47
总花费
$21.12
每次动作
$18.82
每 1000 次展示
134
应用内购买
3,695
共计
2.21%
每次展示
$0.85
每次点击
149
共计`

export const REAL_URL =
  'https://adsmanager.facebook.com/adsmanager/manage/campaigns?act=2131017261144314&business_id=1734414010144999'

describe('parseFbMetricNumber', () => {
  it('parses money, thousands, percentages, and dashes', () => {
    expect(parseFbMetricNumber('$3,146.47')).toBe(3146.47)
    expect(parseFbMetricNumber('$98.07')).toBe(98.07)
    expect(parseFbMetricNumber('1,110')).toBe(1110)
    expect(parseFbMetricNumber('2.61%')).toBe(2.61)
    expect(parseFbMetricNumber('—')).toBeNull()
    expect(parseFbMetricNumber('应用内购买')).toBeNull()
  })
})

describe('parseFbAdsCampaignsSnapshot', () => {
  it('reads the observed CTR-ending viewport and ignores only the exact row hover action strip', () => {
    const text = REAL_CAMPAIGNS_TEXT
      .replace(/(adtiger_[^\n]+\n)((?:[^\n]+\n){9})/g, (_match, name: string, values: string) =>
        name + values.split('\n').slice(0, 7).join('\n') + '\n')
      .replace('Ricky_0825_001\n', 'Ricky_0825_001\n图表\n编辑\n新建副本\n对比\n打开下拉菜单\n')
    const reading = parseFbAdsCampaignsSnapshot({ url: REAL_URL, text })
    expect(reading?.rows).toHaveLength(8)
    expect(reading?.rows[1].ctr).toBe(2.61)
    expect(reading?.rows[1].clicks).toBe(788)
    expect(reading?.rows[1].cpc).toBeNull()
    expect(reading?.rows[1].installs).toBeNull()
    expect(fbAdsReadingRejection(reading!)).toBeNull()
    // Unexpected text must still refuse the page, not be silently stripped.
    expect(parseFbAdsCampaignsSnapshot({ url: REAL_URL, text: text.replace('图表\n编辑\n', '未知内容\n编辑\n') })).toBeNull()
  })

  it.each(['2026年8月12日 – 2026年9月10日', '2026年9月10日'])('recognizes a custom date label: %s', (label) => {
    const reading = parseFbAdsCampaignsSnapshot({
      url: REAL_URL,
      text: REAL_CAMPAIGNS_TEXT.replace('过去 30 天：2026年8月12日 – 2026年9月10日', label)
    })
    expect(reading?.dateRangeLabel).toBe(label)
    expect(fbAdsReadingRejection(reading!)).toBeNull()
  })

  it('parses the real campaigns fixture exactly', () => {
    const reading = parseFbAdsCampaignsSnapshot({
      url: REAL_URL,
      title: '(48) 广告管理工具 - 管理广告 - 广告系列',
      text: REAL_CAMPAIGNS_TEXT
    })
    expect(reading).not.toBeNull()
    expect(reading?.accountId).toBe('2131017261144314')
    expect(reading?.accountName).toBe('COOPLAY-ADT-IOS-03')
    expect(reading?.dateRangeLabel).toBe('过去 30 天：2026年8月12日 – 2026年9月10日')
    expect(reading?.columns).toContain('已花费金额')
    expect(reading?.columns).toContain('应用安装量')
    expect(reading?.rows).toHaveLength(8)

    const idle = reading?.rows[0]
    expect(idle?.name).toBe('adtiger_三國點將令_IOS_aem_HK/TW/SG/MY_aeo_leo_0911_008')
    expect(idle?.spend).toBe(0)
    expect(idle?.clicks).toBe(0)
    expect(idle?.resultType).toBe('应用内购买')

    const active = reading?.rows[1]
    expect(active?.name).toBe('adtiger_三國點將令_IOS_aem_HK/TW_aeo_leo_0908_007')
    expect(active?.spend).toBe(529.08)
    expect(active?.costPerResult).toBe(22.05)
    expect(active?.cpm).toBe(17.51)
    expect(active?.results).toBe(0)
    expect(active?.clicks).toBe(788)
    expect(active?.ctr).toBe(2.61)
    expect(active?.cpc).toBe(0.67)
    expect(active?.installs).toBe(24)

    expect(reading?.totalSpend).toBe(3146.47)
    expect(fbAdsReadingTotalsMatch(reading as never)).toBe(true)
    expect(reading?.campaignCount).toBe(8)
    expect(fbAdsReadingRowsMatchCount(reading as never)).toBe(true)
    expect(fbAdsReadingRejection(reading as never)).toBeNull()
  })

  it('rejects when the view hides rows the summary still counts (hard gate)', () => {
    // Real-world shape from 2026-09-14: the "全部广告" view hid a deleted
    // campaign (its $933.76 spend stayed in the summary). The parser must
    // surface that as a refusal reason, never silently-wrong numbers.
    const lastRow = [
      'adtiger_三國點將令_IOS_MO/HK/TW_FB_aeo_Ricky_0825_001',
      '$933.76',
      '$15.31',
      '$17.88',
      '129',
      '应用内购买',
      '1,110',
      '2.13%',
      '$0.84',
      '61'
    ].join('\n')
    const text = REAL_CAMPAIGNS_TEXT.replace(lastRow + '\n', '')
    const reading = parseFbAdsCampaignsSnapshot({ url: REAL_URL, text })
    expect(reading).not.toBeNull()
    expect(reading?.rows).toHaveLength(7)
    expect(reading?.campaignCount).toBe(8)
    expect(fbAdsReadingRowsMatchCount(reading as never)).toBe(false)
    expect(fbAdsReadingRejection(reading as never)).toBe('incomplete-view')
  })

  it('rejects when row sums drift from the page summary', () => {
    const text = REAL_CAMPAIGNS_TEXT.replace('$529.08', '$529.07')
    const reading = parseFbAdsCampaignsSnapshot({ url: REAL_URL, text })
    expect(reading?.rows).toHaveLength(8)
    expect(fbAdsReadingRowsMatchCount(reading as never)).toBe(true)
    expect(fbAdsReadingRejection(reading as never)).toBe('totals-mismatch')
  })

  it('double-read consistency: identical pass, structure change fail, live tick pass', () => {
    const base = parseFbAdsCampaignsSnapshot({ url: REAL_URL, text: REAL_CAMPAIGNS_TEXT })
    expect(fbAdsReadingsConsistent(base as never, base as never)).toBe(true)

    const renamed = parseFbAdsCampaignsSnapshot({
      url: REAL_URL,
      text: REAL_CAMPAIGNS_TEXT.replace('Ricky_0825_001', 'Ricky_0826_009')
    })
    expect(fbAdsReadingsConsistent(base as never, renamed as never)).toBe(false)

    // Live numbers tick between reads but each stays self-consistent.
    const ticked = parseFbAdsCampaignsSnapshot({
      url: REAL_URL,
      text: REAL_CAMPAIGNS_TEXT.replace('$529.08', '$530.00').replace('$3,146.47', '$3,147.39')
    })
    expect(fbAdsReadingsConsistent(base as never, ticked as never)).toBe(true)
    expect(fbAdsReadingRejection(ticked as never)).toBeNull()
  })

  it('handles the 今天 date-label variant and a small table', () => {
    const text = `广告系列
COOPLAY-ADT-IOS-03 (2131017261144314)
今天：2026年9月10日
关/开
广告系列
已花费金额
单次应用安装费用
CPM（千次展示费用）
成效
点击量（全部）
点击率（全部）
单次点击费用（全部）
应用安装量
移动应用安装量
投放
操作
归因设置
单次成效费用
预算
定制列...
camp_a
$98.07
—
—
—
应用内购买
135
2.51%
$0.73
3
camp_b
$0.00
—
—
—
应用内购买
—
—
—
—
2个广告系列的成效
$98.07
总花费`
    const reading = parseFbAdsCampaignsSnapshot({ url: 'https://adsmanager.facebook.com/x?act=2131017261144314', text })
    expect(reading).not.toBeNull()
    expect(reading?.dateRangeLabel).toBe('今天：2026年9月10日')
    expect(reading?.rows).toHaveLength(2)
    expect(reading?.rows[0].spend).toBe(98.07)
    expect(reading?.rows[0].installs).toBe(3)
    expect(reading?.totalSpend).toBe(98.07)
    expect(fbAdsReadingTotalsMatch(reading as never)).toBe(true)
  })

  it('returns null for non-table pages instead of guessing', () => {
    expect(parseFbAdsCampaignsSnapshot({ text: '登录 Meta 业务工具\n邮箱\n密码' })).toBeNull()
    expect(parseFbAdsCampaignsSnapshot({ text: '' })).toBeNull()
    expect(parseFbAdsCampaignsSnapshot({ text: '关/开\n定制列...' })).toBeNull()
  })

  it('requires the date label; a missing summary total no longer blocks the gate', () => {
    const withoutDate = REAL_CAMPAIGNS_TEXT.replace('过去 30 天：2026年8月12日 – 2026年9月10日\n', '')
    const dateMissing = parseFbAdsCampaignsSnapshot({ url: REAL_URL, text: withoutDate })
    expect(dateMissing).not.toBeNull()
    expect(fbAdsReadingRejection(dateMissing as never)).toBe('incomplete-view')

    // Policy 2026-09-18: announcement banners can push the summary block out
    // of the snapshot (seen on the AND account). Rows=count plus the
    // double-read consistency check still guard completeness; the totals
    // cross-check applies whenever the totals actually render.
    const withoutTotal = REAL_CAMPAIGNS_TEXT.replace('$3,146.47\n总花费\n', '')
    const totalMissing = parseFbAdsCampaignsSnapshot({ url: REAL_URL, text: withoutTotal })
    expect(totalMissing).not.toBeNull()
    expect(fbAdsReadingRejection(totalMissing as never)).toBe(null)
  })

  it('records observation scope and refuses an unknown column layout', () => {
    const reading = parseFbAdsCampaignsSnapshot({ url: REAL_URL, title: 'Ads', observedAt: Date.UTC(2026, 8, 15), text: REAL_CAMPAIGNS_TEXT })
    expect(reading?.observation).toMatchObject({
      sourceUrl: REAL_URL,
      sourceTitle: 'Ads',
      visibleRows: 8,
      readRows: 8,
      totalRows: 8,
      coverage: 'complete',
      columnMode: 'wide'
    })
    expect(parseFbAdsCampaignsSnapshot({ url: REAL_URL, text: REAL_CAMPAIGNS_TEXT.replace('已花费金额', 'Spend') })).toBeNull()
  })

  it('parses the narrow in-app panel render (3 metric columns) and fires the incomplete-view gate on real data', () => {
    // REAL fixture captured 2026-09-14 from the in-app browser panel: the
    // panel is narrow enough that FB column virtualization keeps only the
    // first 3 metric cells per row in the DOM. The "全部广告" view also hid
    // a deleted campaign whose spend stayed in the summary — exactly the
    // condition the hard gate must refuse.
    const text = [
      '广告管理工具',
      '52',
      'COOPLAY-ADT-IOS-03 (2131017261144314)',
      '过去 30 天：2026年8月15日 – 2026年9月13日',
      '关/开',
      '广告系列',
      '已花费金额',
      '单次应用安装费用',
      'CPM（千次展示费用）',
      '成效',
      '点击量（全部）',
      '点击率（全部）',
      '单次点击费用（全部）',
      '应用安装量',
      '移动应用安装量',
      '投放',
      '操作',
      '归因设置',
      '单次成效费用',
      '预算',
      '定制列...',
      'adtiger_三國點將令_IOS_aem_HK/TW/SG/MY_aeo_leo_0911_008',
      '$499.91',
      '$19.23',
      '$14.82',
      'adtiger_三國點將令_IOS_aem_HK/TW_aeo_leo_0908_007',
      '$639.75',
      '$22.85',
      '$16.49',
      'adtiger_三國點將令_IOS_aem_SG/MY_aeo_leo_0904_006',
      '$315.50',
      '$26.29',
      '$17.10',
      'adtiger_三國點將令_IOS_aem_TW_aeo_leo_0904_005',
      '$318.60',
      '$17.70',
      '$18.18',
      'adtiger_三國點將令_IOS_aem_HK_aeo_leo_0904_004',
      '$332.11',
      '$23.72',
      '$23.19',
      'adtiger_三國點將令_IOS_skan_MO/HK/TW_FB_aeo_leo_0901_003',
      '$240.97',
      '$34.42',
      '$14.19',
      'adtiger_三國點將令_IOS_MO/HK/TW_FB_aeo_Ricky_0827_001',
      '$476.45',
      '$36.65',
      '$27.34',
      '8个广告系列的成效',
      '$3,757.05',
      '总花费',
      '$20.99',
      '每次动作',
      '$17.94',
      '每 1000 次展示'
    ].join('\n')
    const reading = parseFbAdsCampaignsSnapshot({
      url: 'https://adsmanager.facebook.com/adsmanager/manage/campaigns?act=2131017261144314',
      text
    })
    expect(reading).not.toBeNull()
    expect(reading?.rows).toHaveLength(7)
    expect(reading?.rows[0].spend).toBe(499.91)
    expect(reading?.rows[0].costPerResult).toBe(19.23)
    expect(reading?.rows[0].cpm).toBe(14.82)
    expect(reading?.rows[0].clicks).toBeNull()
    expect(reading?.totalSpend).toBe(3757.05)
    expect(fbAdsReadingRowsMatchCount(reading as never)).toBe(false)
    // The page's own marker says 8 campaigns but the view renders 7 — a
    // deleted campaign is hidden while its spend stays in the summary. The
    // count gate fires first: refuse, never under-report.
    expect(fbAdsReadingRejection(reading as never)).toBe('incomplete-view')
  })

  it('parses iOS rows whose result-type label is missing on some campaigns', () => {
    const text = [
      '广告管理工具',
      '8',
      'COOPLAY-ADT-IOS-03 (2131017261144314)',
      '2026年9月13日 – 2026年9月19日',
      '关/开',
      '广告系列',
      '成效',
      '已花费金额',
      '展示次数',
      '移动应用安装量',
      '点击量（全部）',
      '定制列...',
      'adtiger_三國點將令_IOS_aem_HK/TW/SG/MY_aeo_leo_0920_013',
      '—',
      '$0.00',
      '—',
      'adtiger_三國點將令_IOS_aem_HK/TW/SG/MY_aeo_leo_0911_008',
      '15',
      '应用内购买',
      '$1,145.80',
      '72,394',
      'adtiger_三國點將令_IOS_aem_HK_aeo_leo_0904_004',
      '—',
      '$0.00',
      '—',
      '13个广告系列的成效',
      '—',
      '多次转化',
      '$1,368.75',
      '总花费'
    ].join('\n')
    const reading = parseFbAdsCampaignsSnapshot({
      url: 'https://adsmanager.facebook.com/adsmanager/manage/campaigns?act=2131017261144314',
      text
    })
    expect(reading).not.toBeNull()
    expect(reading?.rows).toHaveLength(3)
    expect(reading?.rows[0].spend).toBe(0)
    expect(reading?.rows[1].spend).toBe(1145.8)
    expect(reading?.rows[1].resultType).toBe('应用内购买')
    expect(reading?.campaignCount).toBe(13)
    expect(fbAdsReadingRejection(reading as never)).toBe('incomplete-view')
  })

  it('maps metrics by header labels when the preset is reordered', () => {
    const reordered = REAL_CAMPAIGNS_TEXT.replace(
      '单次应用安装费用\nCPM（千次展示费用）',
      'CPM（千次展示费用）\n单次应用安装费用'
    )
    const reading = parseFbAdsCampaignsSnapshot({ url: REAL_URL, text: reordered })
    expect(reading).not.toBeNull()
    const row = reading?.rows.find((r) => r.name.includes('0904_006'))
    // The swapped headers carry their values with them: CPM reads the cell
    // under CPM, cost-per-install reads the cell under 单次应用安装费用.
    expect(row).toMatchObject({ spend: 315.5, cpm: 26.29, costPerResult: 17.1 })
    expect(fbAdsReadingRejection(reading as never)).toBe(null)
  })

  it('parses the AND account view (4 visible metric cells, no summary block)', () => {
    // REAL fixture, captured 2026-09-18 from COOPLAY-ADT-AND-03: the saved
    // column view differs from the IOS preset (成效 before 展示次数/CPM,
    // link-click columns, extra reach/frequency/date columns). A Singapore
    // verification banner pushed the totals out of the snapshot; column
    // virtualization kept only the first four metric cells per row.
    const AND_URL = 'https://adsmanager.facebook.com/adsmanager/manage/campaigns?act=27893958520273993&business_id=1734414010144999'
    const text = [
      '广告管理工具',
      'COOPLAY-ADT-AND-03 (27893958520273993)',
      '2026年9月15日 – 2026年9月17日',
      '关/开',
      '广告系列',
      '已花费金额',
      '单次应用安装费用',
      '成效',
      '展示次数',
      'CPM（千次展示费用）',
      '链接点击量',
      '链接点击率',
      '点击率（全部）',
      '应用安装量',
      '移动应用安装量',
      '投放',
      '操作',
      '归因设置',
      '覆盖人数',
      '频次',
      '单次成效费用',
      '预算',
      '结束日期',
      '店铺点击量',
      '单次链接点击费用',
      '点击量（全部）',
      '落地页浏览量',
      '落地页单次浏览费用',
      '定制列...',
      'adtiger_三國點將令_and_HK/TW_FB_aeo_leo_0908_007',
      '$349.36',
      '$8.73',
      '4',
      '应用内购买',
      'adtiger_三國點將令_and_SG/MY_FB_aeo_leo_0904_006',
      '$210.93',
      '$7.53',
      '10',
      '应用内购买',
      'adtiger_三國點將令_and_TW_FB_aeo_leo_0904_005',
      '$0.00',
      '—',
      '—',
      '应用内购买',
      'adtiger_三國點將令_and_HK_FB_aeo_leo_0904_004',
      '$0.00',
      '—',
      '—',
      '应用内购买',
      'adtiger_三國點將令_and_mo/hk/tw_FB_aeo_leo_0901_003',
      '$0.00',
      '—',
      '—',
      '应用内购买',
      'adtiger_三國點將令_and_mo/hk/tw_FB_aeo_ricky_0827_001',
      '$0.00',
      '—',
      '—',
      '应用内购买',
      'adtiger_三國點將令_and_mo/hk/tw_FB_aeo_ricky_0825_001',
      '$0.00',
      '—',
      '—',
      '应用内购买',
      '7个广告系列的成效'
    ].join('\n')
    const reading = parseFbAdsCampaignsSnapshot({ url: AND_URL, text })
    expect(reading).not.toBeNull()
    expect(reading?.campaignCount).toBe(7)
    expect(reading?.rows).toHaveLength(7)
    expect(reading?.rows[0]).toMatchObject({
      spend: 349.36,
      costPerResult: 8.73,
      results: 4,
      resultType: '应用内购买',
      cpm: null,
      ctr: null
    })
    expect(reading?.totalSpend).toBeNull()
    // Totals were clipped by the banner: the rows=count gate plus the
    // consistency check still verify the read end to end.
    expect(fbAdsReadingRejection(reading as never)).toBe(null)
  })

  it('parses the English UI end to end (labels, dates, summary, totals)', () => {
    const EN_URL = 'https://adsmanager.facebook.com/adsmanager/manage/campaigns?act=27893958520273993&business_id=1734414010144999'
    const text = [
      'Ads Manager',
      'COOPLAY-ADT-AND-03 (27893958520273993)',
      'Last 3 days: Sep 15 – Sep 17, 2026',
      'On/Off',
      'Campaigns',
      'Amount spent',
      'Cost per app install',
      'Results',
      'Impressions',
      'CPM (cost per 1,000 impressions)',
      'Link clicks',
      'Link CTR',
      'CTR (all)',
      'App installs',
      'Mobile app installs',
      'Delivery',
      'Customize columns',
      'adtiger_sanguo_and_HK/TW_aeo_0908_007',
      '$349.39',
      '$8.73',
      '4',
      'Purchases',
      '40,000',
      '$8.73',
      '525',
      '1.31%',
      '1.50%',
      '40',
      '40',
      'adtiger_sanguo_and_SG/MY_aeo_0904_006',
      '$210.94',
      '$7.53',
      '10',
      'Purchases',
      '30,000',
      '$7.03',
      '400',
      '1.33%',
      '1.40%',
      '28',
      '28',
      'adtiger_sanguo_and_TW_aeo_0904_005',
      '$0.00',
      '—',
      '—',
      'Purchases',
      '10,000',
      '$0.00',
      '0',
      '0.00%',
      '0.00%',
      '—',
      '—',
      'Performance for 3 campaigns',
      '$560.33',
      'Amount spent'
    ].join('\n')
    const reading = parseFbAdsCampaignsSnapshot({ url: EN_URL, text })
    expect(reading).not.toBeNull()
    expect(reading?.dateRangeLabel).toBe('Last 3 days: Sep 15 – Sep 17, 2026')
    expect(reading?.rows[0]).toMatchObject({
      spend: 349.39,
      costPerResult: 8.73,
      results: 4,
      resultType: 'Purchases',
      impressions: 40_000,
      clicks: 525,
      installs: 40
    })
    expect(reading?.totalSpend).toBe(560.33)
    expect(fbAdsReadingRejection(reading as never)).toBe(null)
  })

  it('auto-aligns an unknown column that renders a value', () => {
    // A column outside the dictionary (e.g. a rarely used metric) renders a
    // plain number. The solver must consume exactly one token for it and
    // keep every known field correctly typed.
    const withUnknown = REAL_CAMPAIGNS_TEXT.replace(
      '成效\n点击量（全部）',
      '成效\n店铺收藏量\n点击量（全部）'
    ).replace(/应用内购买\n/g, '应用内购买\n355\n')
    const reading = parseFbAdsCampaignsSnapshot({ url: REAL_URL, text: withUnknown })
    expect(reading).not.toBeNull()
    const row = reading?.rows.find((r) => r.name.includes('0908_007'))
    expect(row).toMatchObject({ spend: 529.08, clicks: 788, ctr: 2.61 })
    expect(fbAdsReadingRejection(reading as never)).toBe(null)
  })

  it('auto-aligns an unknown column that renders no text (icon-like)', () => {
    const withUnknown = REAL_CAMPAIGNS_TEXT.replace(
      '成效\n点击量（全部）',
      '成效\n自定义状态\n点击量（全部）'
    )
    const reading = parseFbAdsCampaignsSnapshot({ url: REAL_URL, text: withUnknown })
    expect(reading).not.toBeNull()
    const row = reading?.rows.find((r) => r.name.includes('0908_007'))
    expect(row).toMatchObject({ spend: 529.08, clicks: 788, ctr: 2.61 })
  })

  it('merges virtualized iOS pages until the footer campaign count is complete', () => {
    const header = [
      '广告管理工具',
      '8',
      'COOPLAY-ADT-IOS-03 (2131017261144314)',
      '2026年9月20日',
      '关/开',
      '广告系列',
      '成效',
      '已花费金额',
      '展示次数',
      '移动应用安装量',
      '点击量（全部）',
      '定制列...'
    ]
    const footer = ['13个广告系列的成效', '$120.63', '总花费']
    const page = (rows: string[]) => parseFbAdsCampaignsSnapshot({
      url: 'https://adsmanager.facebook.com/adsmanager/manage/campaigns?act=2131017261144314',
      text: [...header, ...rows, ...footer].join('\n')
    })
    const first = page([
      'camp_01', '—', '$10.00', '100',
      'camp_02', '—', '$20.00', '200',
      'camp_03', '—', '$30.00', '300'
    ])
    const second = page([
      'camp_04', '—', '$5.00', '50',
      'camp_05', '—', '$6.00', '60',
      'camp_06', '—', '$7.00', '70',
      'camp_07', '—', '$8.00', '80',
      'camp_08', '—', '$9.00', '90',
      'camp_09', '—', '$1.00', '10',
      'camp_10', '—', '$2.00', '20',
      'camp_11', '—', '$3.00', '30',
      'camp_12', '—', '$4.00', '40',
      'camp_13', '—', '$15.63', '163'
    ])
    expect(first).not.toBeNull()
    expect(second).not.toBeNull()
    expect(fbAdsReadingRejection(first as never)).toBe('incomplete-view')
    const merged = mergeFbAdsCampaignReadings([first!, second!])
    expect(merged?.rows).toHaveLength(13)
    expect(merged?.totalSpend).toBe(120.63)
    expect(fbAdsReadingRejection(merged as never)).toBe(null)
  })

  it('refuses to merge pages whose footer campaign counts disagree', () => {
    const header = [
      '广告管理工具',
      '8',
      'COOPLAY-ADT-IOS-03 (2131017261144314)',
      '2026年9月20日',
      '关/开',
      '广告系列',
      '成效',
      '已花费金额',
      '展示次数',
      '移动应用安装量',
      '点击量（全部）',
      '定制列...'
    ]
    const page = (rows: string[], footer: string) => parseFbAdsCampaignsSnapshot({
      url: 'https://adsmanager.facebook.com/adsmanager/manage/campaigns?act=2131017261144314',
      text: [...header, ...rows, footer, '$10.00', '总花费'].join('\n')
    })
    const first = page(['camp_01', '—', '$10.00', '100'], '10个广告系列的成效')
    const second = page(['camp_01', '—', '$10.00', '100'], '9个广告系列的成效')
    expect(first).not.toBeNull()
    expect(second).not.toBeNull()
    expect(mergeFbAdsCampaignReadings([first!, second!])).toBeNull()
  })
})
