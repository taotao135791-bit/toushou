import { app } from 'electron'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { KERNEL_VIRAL_SKILL_ID } from '../shared/skills'

/**
 * 爆款竞品分析 kernel skill.
 *
 * The viral-competitive-analysis chain (TikTok account performance →
 * SocialPeta competitor evidence → 需求单 → Feishu/board) is product
 * kernel: it must exist on every install regardless of which optional
 * toolkits the user removed. So unlike toolkit-packaged skills (which ride
 * resources/<toolkit>/skills and come and go with the package), this one is
 * installed into userData/skills at every startup.
 *
 * User edits are respected while the version stays the same; a bump in the
 * bundled version wins over local edits, so kernel improvements propagate.
 */

export const KERNEL_SKILL_FILE_NAME = KERNEL_VIRAL_SKILL_ID
export const KERNEL_SKILL_ID = KERNEL_SKILL_FILE_NAME
export const KERNEL_SKILL_VERSION = 1

const VERSION_MARKER_RE = /<!-- toushou:kernel-skill v(\d+) -->/

/** The task template prompt references the skill by name; keep in sync. */
export const KERNEL_SKILL_DISPLAY_NAME = '爆款竞品分析'

export const KERNEL_SKILL_MARKDOWN = `<!-- toushou:kernel-skill v${KERNEL_SKILL_VERSION} -->
---
name: 爆款竞品分析
description: 周度爆款竞品分析打法：从我方 TikTok 账户表现找出薄弱点，用 SocialPeta 竞品爆款证据对标，产出可执行的「爆款竞品分析需求单」。当用户要求竞品分析、爆款对标、素材调研、周度复盘时使用。
---

# 爆款竞品分析（周度打法）

把「我方账户表现」和「竞品爆款证据」合成一份可执行的需求单。全程只用工具返回的真实数据——没有数据支撑的格子写"证据不足"，禁止编造。

## 第 0 步：工具自检（必须最先做）

确认两组 MCP 工具都在：
- **tiktok**（41 个，如 report_integrated_get、smart_plus_campaign_get）：我方账户表现
- **socialpeta**（10 个，如 search_creatives、creative_rank）：竞品素材库

任一组不可用 → 回复「MCP 未挂载：缺少 XX 工具，请重开会话后重试」，**停止分析**。用不完整的数据源编出来的结论会误导投放决策，宁可不做。

## 第 1 步：我方账户体检（tiktok 工具）

拉取近 7-14 天投放数据，输出「薄弱点清单」：
- 大盘：消耗/展示/点击/转化趋势，环比变化
- 素材维度：哪些素材在衰减（消耗降、CPA/CPM 升）、哪些在起量
- 市场维度：分国家/语言的消耗与成本

每条薄弱点 = 现象 + 具体数据 + 怀疑原因（标注是怀疑）。

## 第 2 步：把薄弱点翻译成对标问题

每条薄弱点变成一个具体的检索问题，例：
- 素材衰减 → "同品类近 7 天上升素材在用什么钩子/结构？"
- 市场掉量 → "该市场头部竞品本周在投什么素材？投放强度多大？"

## 第 3 步：竞品爆款检索（socialpeta 工具）

- **creative_rank**：本品类 + 我方目标市场 + weekly rising（上升榜）——爆款发现的入口
- **search_creatives**：对标竞品广告主 + 近 7 天新素材
- **creative_detail**：Top 素材的热度趋势、文案、落地页
- **advertiser_analysis / advertiser_download_revenue**：对手投放强度与营收趋势

国家/平台/品类代码不确定时先 dictionary_lookup，不要猜代码。检索结果只是候选池，进需求单前用 creative_detail 核对。

## 第 4 步：输出「爆款竞品分析需求单」

固定结构（今天的日期 + 数据窗口写在标题行）：

\`\`\`
## 爆款竞品分析需求单（YYYY-MM-DD · 数据窗口 MM-DD ~ MM-DD）

### 一、我方薄弱点
| # | 现象 | 数据 | 怀疑原因 |
|---|---|---|---|

### 二、竞品爆款证据
| 对标问题 | 竞品/素材 | 关键数据（工具返回） | 爆点拆解 |
|---|---|---|---|

### 三、本周可执行动作假设
1. （每条：改什么 → 预期影响什么指标 → 怎么验证）

### 四、数据缺口与下一步
（哪些结论证据不足、需要用户补充什么）
\`\`\`

数字纪律：只写工具返回的数字；曝光量 ≠ 转化，禁止"效果最好/一定能降 CPA"式表述；推测必须标注"推测"。

## 第 5 步：分发

- 用户在看板语境下要求数据时：把素材/榜单整理成 \`\`\`board-cards 围栏（JSON 一行、双引号、无尾逗号，最多 12 张卡），用户点 Apply 才落板——围栏是唯一入口，禁止另写文件交付看板数据
- 提醒用户：本分析可每周自动执行。用户同意后直接用 toushou_task_create 工具创建（weekly 周一 09:00、skillId 填「爆款竞品分析.md」），或指引到定时任务页使用「每周爆款竞品分析」模板并开启"推送到飞书"
- 需求单的"动作假设"确认后，可直接进入《素材需求文档》流程（飞书里建素材需求批次）
`

/** Install (or version-upgrade) the kernel skill into the user's library. */
export function ensureKernelSkill(): { ok: boolean; error?: string } {
  try {
    const dir = path.join(app.getPath('userData'), 'skills')
    mkdirSync(dir, { recursive: true })
    const file = path.join(dir, KERNEL_SKILL_FILE_NAME)
    let current: string | null = null
    try {
      current = readFileSync(file, 'utf-8')
    } catch {
      current = null
    }
    if (current !== null) {
      const currentVersion = Number(VERSION_MARKER_RE.exec(current)?.[1] ?? 0)
      // Same version → keep whatever is on disk (the user may have tuned the
      // playbook for the team); a newer bundled version replaces it.
      if (currentVersion >= KERNEL_SKILL_VERSION) return { ok: true }
    }
    writeFileSync(file, KERNEL_SKILL_MARKDOWN, 'utf-8')
    return { ok: true }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : 'kernel-skill-install-failed' }
  }
}
