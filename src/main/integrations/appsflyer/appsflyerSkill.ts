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

# AppsFlyer 事件分析与活看板

- 先用 get_apps 确认可访问的 App；优先沿用当前项目已确认的应用和账户范围，只有范围确实有歧义时才问用户。
- 用户使用业务名称时，不要求用户给技术字段。只沿用当前客户、当前项目已确认的事件映射；没有映射时，以 in_app_event=[]、Event name 分组发现真实候选，结合业务含义与当前项目报表选择唯一最匹配的事件。多个候选同样合理时只问一个简短问题。自定义事件不限 af_ 前缀，保存发现后的准确名称，刷新时复用映射。不同客户的事件名称、阶段和漏斗定义不得相互复制；开发和生成验收只使用合成标识与读数。
- 同时查询 TikTok 和 AF 时按当前项目、已确认账户/App、媒体来源和所选日期取数。保留各源元数据；不把正常来源差异自动写成故障或断言已经找到差异原因。
- 默认建可刷新的业务看板：用 toushou_af_dataset_pull 保存完整查询条件，数字卡/图表绑定返回的 dataset.id；不要把本次结果手填为 manual。只有用户明确要求固定快照时才使用固定值。
- 首次取数传 startDate/endDate，与看板总控实际日期一致；切日期和刷新都重新查询媒体与 AF。备用 days 默认近7个完整日，截至昨天。Geo 维度与地区筛选分开；指定地区就筛其真实代码，要全部地区就省略 Geo 过滤，不能传字面值 all。
- 先遵循用户的用途、风格、结构和参考；后续对话按要求增量定制，不重置模板，不强行补回默认模块。只有用户没有具体方向时，才采用业务看板兜底方案：可刷新指标、真实按日趋势、当前业务阶段漏斗、简短分析、三方数据及广告后台指标对应；日报增加表格。组件顺序和布局由任务决定，预算、素材、获客、收入、留存与日报应有不同重点。
- 媒体来源由当前项目实际范围决定，不因使用 AF 就强制 TikTok。无结构要求时可选择相应平台模板作为起点，自定义结构可用 blank 并保留活数据绑定；已有板保留未要求修改的媒体卡。新业务查询显式传 mediaSources，使用当前App真实发现并确认的媒体名称；[]表示该App全部授权来源，可用于发现候选。省略仅兼容旧TikTok调用，不根据品牌猜接口别名，不错标来源。
- 趋势必须使用真实日期粒度；漏斗阶段采用当前业务的已确认事件与计数定义。跨来源阶段对照不自动等于同一批用户的转化率，activity 数据不能冒充获客 cohort。将广告后台指标与三方指标逐项对应，保留业务已确认的事件映射与报告类型；不因正常来源差异打断分析。
- metrics、groupings 用官方返回的可用名称，最多4个维度。数字卡用 dataset.columns 的实际列名；Count 是事件次数，Unique users 是独立用户，activity 与 ltv 分别查询。独立用户查询完整期间的专用总量，不按日或活动相加。
- 首屏只展示关键指标、短来源/日期标签和2–3条业务 highlight。技术参数、口径、完整性及失败诊断按需查看，不自动铺成长说明卡。缺失或失败不补零，保留可重试状态；凭据和授权信息不得出现在内容中。
- analysis应绑定当前任务的目标事件和指标；事件发现数据含多个事件时，先按真实事件筛选或另拉目标事件查询，不把不同事件的sum当优化成效。阶段对照可用各阶段明确筛选，不能把业务不同阶段混算一个目标。
- 创建或定制后回读实际看板与数据绑定，并调用board_check检查查询配方、具体日期、趋势日期列、阶段来源、分析证据和日报表格。非ready时在同一轮修复缺失或失效绑定再检查；连接、权限或无数据受阻时明确blocked，不以一次检查调用代替完成。只报告实际可用的组件与验证结果，不用静态数字、占位曲线或长说明卡假充。
- 只读取请求范围，不创建链接或修改广告账户。创建/更新本机看板及其查询条件沿用用户授权。
`
