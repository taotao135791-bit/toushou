export const APPSFLYER_SKILL_FILE = 'toushou-appsflyer.md'
export const APPSFLYER_SKILL = `---
name: toushou-appsflyer
description: Read AppsFlyer aggregated events and compare TikTok campaign reporting.
---

# AppsFlyer 只读事件分析

- 先用 get_apps 发现可访问的 App；明确用户要查看的单个 App 与日期，不能猜测。
- 使用 analytics_fetch_aggregated_data：先将 in_app_event 设为空并按 Event name 分组，发现有数据的事件；再选择准确的事件名称查询。
- 同时查看 TikTok 时，只按明确的 Campaign ID、媒体来源与活动日期关联；日期、时区及归因口径不同不能直接比较或当成归因证明。
- Count 是事件次数，Unique users 是去重用户；activity 是活动日期，LTV 是生命周期口径，不可混同。金额应保留币种，不跨币种加总。
- 清楚说明日期、时区、筛选、缺失/失败与不完整；返回行数达到上限可能截断，不能当成全量。不要凭空补零。
- 只读取用户明确要求的范围；不要创建链接、修改账户或发布数据。凭据、授权信息不能出现在回答中。
`
