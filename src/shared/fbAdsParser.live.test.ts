import { describe, expect, it } from 'vitest'
import { fbAdsReadingRejection, fbAdsReadingTotalsMatch, parseFbAdsCampaignsSnapshot } from './fbAdsParser'
import { REAL_CAMPAIGNS_TEXT } from './fbAdsParser.test'

// Live capture taken minutes ago (2026-09-11 evening): identical numbers to
// the stored fixture (same 30-day window) but with extra filter-chip lines
// before the header block. Reuses the real fixture text plus those lines to
// prove the parser is robust to that UI variance.
const LIVE_TEXT = REAL_CAMPAIGNS_TEXT.replace(
  '搜索以按如下条件筛选：名称、编号或指标\n广告系列',
  '搜索以按如下条件筛选：名称、编号或指标\n投放状态\n目标\n花费\n操作\n名称、编号或指标\n广告系列'
)

describe('live capture', () => {
  it('parses the fresh page shape and matches visible numbers', () => {
    expect(LIVE_TEXT).not.toBe(REAL_CAMPAIGNS_TEXT)
    const reading = parseFbAdsCampaignsSnapshot({
      url: 'https://adsmanager.facebook.com/adsmanager/manage/campaigns?act=2131017261144314',
      text: LIVE_TEXT
    })
    expect(reading).not.toBeNull()
    expect(reading?.rows).toHaveLength(8)
    expect(reading?.totalSpend).toBe(3146.47)
    expect(fbAdsReadingTotalsMatch(reading as never)).toBe(true)
    const active = reading?.rows[1]
    expect(active?.spend).toBe(529.08)
    expect(active?.clicks).toBe(788)
    expect(active?.installs).toBe(24)
  })
})

// Real archived capture from 2026-09-17 (fb-snapshots.json, last entry of the
// board-reading test run): stretched-panel shape with the measurement-change
// announcement banner present and each row rendering 8 value cells (the
// trailing 应用安装量 cell missing while its header stays). The parser must
// read this shape with installs=null — banner included — and the strict gates
// (rows==summary count, row sums==total spend) must still pass.
const STRETCHED_8CELL_TEXT = `广告管理工具
​
57
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
73
机会分数
更新时间：刚刚
刷新表格数据
​
放弃草稿
检查并发布(3)
菜单
​
全部广告
投放过
Actions
正在投放的广告
正在投放的广告
查看更多
创建视图
设置
​
搜索以按如下条件筛选：名称、编号或指标
广告系列
广告组
广告
过去 7 天：2026年9月10日 – 2026年9月16日
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
$1,074.79
$18.86
$14.66
20
应用内购买
7,567
10.32%
$0.14
adtiger_三國點將令_IOS_aem_HK/TW_aeo_leo_0908_007
$284.40
$25.85
$15.09
—
应用内购买
512
2.72%
$0.56
adtiger_三國點將令_IOS_aem_SG/MY_aeo_leo_0904_006
$0.00
—
—
—
应用内购买
—
—
—
adtiger_三國點將令_IOS_aem_TW_aeo_leo_0904_005
$0.00
—
—
—
应用内购买
—
—
—
adtiger_三國點將令_IOS_aem_HK_aeo_leo_0904_004
$0.00
—
—
—
应用内购买
—
—
—
adtiger_三國點將令_IOS_skan_MO/HK/TW_FB_aeo_leo_0901_003
$0.00
—
—
—
应用内购买
—
—
—
adtiger_三國點將令_IOS_MO/HK/TW_FB_aeo_Ricky_0827_001
$0.00
—
—
—
应用内购买
—
—
—
adtiger_三國點將令_IOS_MO/HK/TW_FB_aeo_Ricky_0825_001
$0.00
—
—
—
应用内购买
—
—
—
8个广告系列的成效
​
$1,359.19
总花费
$19.99
每次动作
$14.75
每 1000 次展示
20
应用内购买
8,079
共计
8.77%
每次展示
$0.17
每次点击`

describe('stretched-panel 8-cell capture (2026-09-17, banner present)', () => {
  it('parses with installs null and passes every strict gate', () => {
    const reading = parseFbAdsCampaignsSnapshot({
      url: 'https://adsmanager.facebook.com/adsmanager/manage/campaigns?act=2131017261144314&business_id=1734414010144999&date=2026-09-10_2026-09-16,last_7d&insights_date=2026-09-10_2026-09-16,last_7d',
      text: STRETCHED_8CELL_TEXT
    })
    expect(reading).not.toBeNull()
    expect(reading?.rows).toHaveLength(8)
    expect(reading?.campaignCount).toBe(8)
    expect(reading?.totalSpend).toBe(1359.19)
    expect(reading?.dateRangeLabel).toContain('2026年9月10日')
    const first = reading?.rows[0]
    expect(first?.name).toContain('0911_008')
    expect(first?.spend).toBe(1074.79)
    expect(first?.costPerResult).toBe(18.86)
    expect(first?.cpm).toBe(14.66)
    expect(first?.results).toBe(20)
    expect(first?.resultType).toBe('应用内购买')
    expect(first?.clicks).toBe(7567)
    expect(first?.ctr).toBe(10.32)
    expect(first?.cpc).toBe(0.14)
    expect(first?.installs).toBeNull()
    expect(fbAdsReadingTotalsMatch(reading as never)).toBe(true)
    expect(fbAdsReadingRejection(reading as never)).toBeNull()
  })
})
