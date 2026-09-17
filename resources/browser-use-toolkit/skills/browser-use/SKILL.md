---
name: browser-use
description: 用投手内置浏览器完成网页操作任务：导航、读内容、点击、输入、滚动。源码快照优先，截图兜底。当用户要求浏览网页、查资料填表、操作在线页面时使用。
---

# 浏览器操纵（Browser Use）

在投手内置浏览器里替用户完成网页任务。用户全程可见页面——你开的每个页面、点的每个按钮，都真实发生在应用内的浏览器面板上。

## 铁律：源码优先，截图兜底

1. **先用 `browser_snapshot`**：正文文本 + 可交互元素清单（带 ref 编号）一次到手，便宜且精确
2. **只有源码回答不了才用 `browser_screenshot`**：判断视觉版面、确认渲染效果、页面是纯图片/Canvas 时
3. 截图返回的是 PNG 路径——用你的文件读取能力查看它
4. **FB Ads Manager 页面读数用 `browser_report`**：返回结构化 JSON（消耗/点击/安装等逐行数字 + 汇总交叉校验），比转抄正文精确；非 Ads Manager 页它会明确报 unparseable-page，此时再退回 snapshot
5. **FB 数字只认两个来源**：`browser_report`（verified=true）与 `fb_history`。快照/截图里看到的 FB 数字**永远不能**进入任何交付物——看板卡片、文件、汇报正文都不行，"标注口径仅供参考"也不行。读不了就如实说读不了

## 标准工作流

```
browser_navigate(url)          → 打开目标页（第一步永远是它）
FB 广告后台读数 → browser_report()（结构化数字，已交叉校验）
browser_snapshot()             → 读正文 + 拿元素 ref 清单
  ├─ 信息够 → 直接回答/交付
  ├─ 要进页面 → browser_click(ref)
  ├─ 要搜索/填表 → browser_type(ref, text, submit?)
  ├─ 内容没加载完 → browser_wait(ms) 后重新 snapshot
  └─ 长页面 → browser_scroll(down) 后重新 snapshot
```

## 操作纪律

- **每一步之后页面会变**：点击、输入提交、滚动后，重新 `browser_snapshot` 再决定下一步；ref 编号随快照刷新，绝不过期使用
- ref 必须来自**最近一次**快照；找不到 ref 就重新快照
- 表单提交前确认字段填对了（快照里能看到 value）
- 页面卡住不动 → `browser_wait` + 重试一次 → 仍失败如实报告，不要瞎猜
- 登录、支付、删除类操作：**先向用户说明并获得明确同意**再动手

## 与其他工具的分工

- 只需要网页**文本内容**做分析时，优先用普通网页抓取工具（更省）；需要**交互**（点击/输入/多步流程）或需要**给用户展示过程**时才用浏览器
- 广告工具接产品资料时：落地页可以直接 navigate + snapshot 提取事实，填进接入表

## FB 读数上板（board-cards 提议）

用户要把 FB 消耗放上投手看板时：

1. **拿数**：实时数用 `browser_report`（verified 才有数字）；趋势/对比用 `fb_history`（本地验证读数历史）
2. **提议**：把数字整理成 `board-cards` 代码围栏（JSON：`{"version":1,"cards":[...]}`，最多 12 张卡）。常用组合：
   - metric 卡：`{"type":"metric","title":"FB 近30天总消耗","value":3146.47,"unit":"USD"}`
   - list 卡：`{"type":"list","title":"广告系列消耗","items":["_008 $499.84","_007 $639.75"]}`
   - 标题里注明账户与时间范围；数值必须来自工具返回，禁止估算
   - **输出格式就是围栏本身**——在回复正文中直接输出三反引号 board-cards 围栏代码块，聊天会把它渲染成带 Apply 按钮的预览卡：

`````board-cards
{"version":1,"cards":[
  {"type":"metric","title":"三国IOS 近30天总消耗","value":3146.47,"unit":"USD"},
  {"type":"list","title":"广告系列消耗","items":["_008 $499.84"]}
]}
`````

   除围栏外**不要**另写 .md/.json 文件交付看板数据——围栏是唯一入口，用户点 Apply 才落板
   - **JSON 写法保险**：压成一行输出（不换行、无注释、无尾逗号、键名双引号、数字不加引号）——围栏 JSON 不合法时整卡无法应用
3. **用户 Apply 才落板**：围栏会渲染成预览卡，用户选看板并点应用后才写入——绝不代替用户确认，数值与工具返回不一致时不提议
4. **落板只有围栏一条路**：禁止用写文件（.md/.json 等）绕过 board-cards 围栏交付看板数据；文件里也不得出现未验证的 FB 数字

## FB 自然语言读数（说人话即可）

用户会用口语下指令，例如"打开 fb 三国那个账户，ios，看这三天开启的 camp 消耗"。你的职责是把口语翻译成**一次 URL 拼装 + browser_report**，全程不反问技术问题。

### 账户别名表（团队维护，新账户补一行）

| 口语说法 | act | business_id | 账户名 |
|---|---|---|---|
| 三国 ios / 三国点将令 ios / cooplay ios | 2131017261144314 | 1734414010144999 | COOPLAY-ADT-IOS-03 |

别名解析规则（顺序执行）：
1. 命中唯一别名 → 直接用对应 act 拼 URL
2. 未命中 → 打开账户列表页 `adsmanager.facebook.com/adsmanager/manage/accounts?business_id=<bid>` 快照匹配：唯一匹配 → 用；**多个匹配 → 把候选名和编号列给用户选，禁止猜**；零匹配 → 如实说没找到，并列出别名表现有条目

### URL 语法（日期与筛选免点击直达）

基础：`https://adsmanager.facebook.com/adsmanager/manage/campaigns?act=<act>&business_id=<bid>`
- 时间范围：**date 与 insights_date 必须同时带**，缺一个 Ads Manager 可能忽略（例：`&date=2026-09-12_2026-09-15,last_3d&insights_date=2026-09-12_2026-09-15,last_3d`），预设可用 today / last_3d / last_7d / last_14d / last_30d
- 只要投放中的系列：`&filter_set=campaign.impressions-NUMBER%5EGREATER_THAN%5E0%1DCAMPAIGN_GROUP_DELIVERY_STATUS-STRING_SET%5EIN%5E%5B%22active%22%5D`
- 流程固定为：拼 URL → `browser_navigate` → `browser_report`。日期与筛选**全部走 URL 参数**；FB 页面内点击（日期选择器/视图标签）会被只读边界拦截，那是设计行为，不要尝试
- **面板被其他会话占用**（`panel-owned-by-another-session`）：`browser_navigate` 请求体加 `"takeover": true` 即可接管面板（takeover 仅 navigate 支持）。发起新读数的会话默认带上，避免被上一次会话的持有权卡死
- **URL 参数未生效时**（快照日期标签没变）：**禁止**改用点击去切换日期/视图——点击必被拦截，只会陷入空转。正确做法：按当前口径读数，并在卡片标题与汇报里如实注明（如"30 天口径"）；同时把未生效的参数原样告诉用户

### 登录页中转 ≠ 未登录（2026-09-17 实战教训）

Ads Manager 导航在会话校验时会 302 经过 `business.facebook.com/business/loginpage` 中转页，再自动跳回 Ads Manager。`browser_navigate` 在 `domcontentloaded` 时刻返回的 URL 可能正好落在中转页——**这是校验中转，不是登录墙**。

- **禁止**凭一次中转 URL 就判「未登录」并放弃；真实判定标准是：等待 3–5 秒后再次 `browser_snapshot`，看**最终 URL 与页面内容**（有账户名/系列表格 = 已登录；仍停在 loginpage 且出现密码输入框 = 真未登录）
 `browser_report` 内部自带多轮等待重读，中转几秒内结束它会自己读到最终页——所以即使怀疑中转，也**先跑一次 browser_report**，让它的事实说话
- 只有二次确认仍停在登录页时，才提示用户在浏览器面板完成登录

### 拒报时的处理

`browser_report` 返回错误码（incomplete-view / totals-mismatch / unstable-page / unparseable-page）时：**如实转述错误码与含义，不输出任何数字，不出看板提议**。可以建议用户换视图（如"投放过"）后重试——但换视图是用户手上的操作。

## 诚实汇报

向用户描述操作结果时，只陈述工具返回的事实（URL、标题、快照文本）；页面行为推测要标注是推测。
