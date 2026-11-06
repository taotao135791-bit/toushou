export const META_ADS_SKILL_FILE = 'toushou-meta-ads.md'
export const META_ADS_SKILL = `---
name: toushou-meta-ads
description: 连接 Meta、Facebook、FB 广告，查看账户和投放表现的默认流程；通过 Pipeboard MCP 只读查询，无需用户提及 MCP。
---

# Meta Ads 只读查询

- “连接 Meta / Facebook / FB”、查看账户、查询广告数据及创建平台看板默认走本连接，无需用户说 MCP。未连接时指引“连接 → Meta Ads → 连接 Meta”，用户完成 OAuth；工具缺失或失败时如实说明，不自动退回 Ads Manager 浏览器抓数。旧网页抓数已暂停；历史报表仅查看已保存数据，不重新抓取。
- 创建 Meta 看板默认使用投手本地前端模块：toushou_board_create(template: meta)，模板内置 meta-reading，选择已授权账户后经 Main 读取，联动 counter、chart-line、chart-bar、note。不要生成整页 HTML file 代替默认看板；TT/TikTok 看板必须使用 tiktok 模板。只有用户明确要求自定义 HTML 时才生成 HTML。
- 指标缺失保持 null，趋势只有取得每日明细才能绘制。来源便签记录账户、日期、币种、时区、读取时间和分页完整性。原生读数模块支持刷新和总控日期切换；不要将已绑定卡片改成 manual 固定快照。
- 使用 meta-ads MCP；先用 get_ad_accounts 获取已授权账户，按用户要求选择范围。
- 本连接由第三方 Pipeboard 提供，不是 Meta 官方 MCP；数据及授权经过 Pipeboard。账户发现失败、未关联账户或无权限时明确提示，不猜测账户或结果。
- 查询前先看工具返回的 inputSchema，不猜测参数；明确账户、日期、指标、层级及筛选。
- 使用 get_insights 查询广告对象和表现，保留日期、账户时区、币种和分页信息。缺失不补零，不把截断的结果当成全量，不跨币种相加。
- Meta 数据是平台投放及平台归因口径；AppsFlyer/Adjust 的安装、付费和收入另列来源，比较前对齐日期与归因口径。
- 仅允许账户发现和广告对象读数，不修改广告、预算、状态、账户权限，不输出凭据。
- 本连接不会替换现有 FB 浏览器报表或自动刷新看板；不要声称未执行的同步已经完成。
`
