import { describe, expect, it } from 'vitest'
import {
  fbAdsReadingRejection,
  fbAdsReadingRowsMatchCount,
  fbAdsReadingTotalsMatch,
  fbAdsReadingsConsistent,
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
    expect(idle?.clicks).toBeNull()
    expect(idle?.resultType).toBe('应用内购买')

    const active = reading?.rows[1]
    expect(active?.name).toBe('adtiger_三國點將令_IOS_aem_HK/TW_aeo_leo_0908_007')
    expect(active?.spend).toBe(529.08)
    expect(active?.costPerResult).toBe(22.05)
    expect(active?.cpm).toBe(17.51)
    expect(active?.results).toBeNull()
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

  it('refuses parsed views that lack a required date or summary total', () => {
    const withoutDate = REAL_CAMPAIGNS_TEXT.replace('过去 30 天：2026年8月12日 – 2026年9月10日\n', '')
    const dateMissing = parseFbAdsCampaignsSnapshot({ url: REAL_URL, text: withoutDate })
    expect(dateMissing).not.toBeNull()
    expect(fbAdsReadingRejection(dateMissing as never)).toBe('incomplete-view')

    const withoutTotal = REAL_CAMPAIGNS_TEXT.replace('$3,146.47\n总花费\n', '')
    const totalMissing = parseFbAdsCampaignsSnapshot({ url: REAL_URL, text: withoutTotal })
    expect(totalMissing).not.toBeNull()
    expect(fbAdsReadingRejection(totalMissing as never)).toBe('incomplete-view')
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

  it('rejects a reordered preset instead of mapping metrics by the wrong position', () => {
    const reordered = REAL_CAMPAIGNS_TEXT.replace(
      '单次应用安装费用\nCPM（千次展示费用）',
      'CPM（千次展示费用）\n单次应用安装费用'
    )
    expect(parseFbAdsCampaignsSnapshot({ url: REAL_URL, text: reordered })).toBeNull()
  })
})
