export const APPSFLYER_SKILL_FILE = 'toushou-appsflyer.md'
/** The v1 skill as first shipped — installSkill may refresh an UNMODIFIED copy of exactly this. */
export const APPSFLYER_SKILL_V1 = `---
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
- 构建 AppsFlyer 看板时用 toushou_af_dataset_pull 拉数：每组分维度数据一个 name（如 安装量 / Geo分布 / 7日留存），数据集自动命名为 AF-{name}；数字卡/图表绑到对应数据集（活卡，总控刷新会自动重拉），不要把 AF 数字当静态值手填进卡片。
- 多维拉数：groupings 可带 Geo / Event name / Media source / Date；metrics 可用 Count / Unique users / Installs / Active users / Revenue；basis 选 activity（活动日期）或 ltv（生命周期），不要混同。
- 卡片标题写「AF-{name}」形式（如 AF-安装量、AF-Geo分布），与 TikTok/FB 卡片一眼区分。
- AF 卡片是增量添加：往已有看板 board_add_widget 加 AF 卡；建 AF 专属看板时先用 tiktok 模板建板（自带分账户读数、消耗、余额等标准账户维度数据卡），再逐张添加 AF 卡——标准账户基础数据和 AF 多维数据是同一块板的两层，不要顾此失彼。
- CPI/留存率这类跨源或比值指标：AF 管线给分子分母（安装量、活跃），比值卡若无法活绑就在刷新后由对话重算并明确标注口径。
`
