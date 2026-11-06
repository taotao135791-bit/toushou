# 投手

投手是桌面原生广告优化师 Agent，帮助你读取广告数据、分析表现、制作看板和整理报告。广告平台读数使用只读请求；本机看板和文件操作遵循会话权限与确认设置。

## 下载与安装

当前正式版本：**v2.3.1**。安装包和校验文件也可在 [GitHub Release](https://github.com/taotao135791-bit/toushou/releases/tag/v2.3.1) 查看。

| 平台 | 下载 |
| --- | --- |
| macOS Apple Silicon | [DMG](https://github.com/taotao135791-bit/toushou/releases/download/v2.3.1/TouShou-arm64.dmg) · [ZIP](https://github.com/taotao135791-bit/toushou/releases/download/v2.3.1/TouShou-arm64.zip) |
| macOS Intel | [DMG](https://github.com/taotao135791-bit/toushou/releases/download/v2.3.1/TouShou-x64.dmg) · [ZIP](https://github.com/taotao135791-bit/toushou/releases/download/v2.3.1/TouShou-x64.zip) |
| Windows x64 | [安装程序](https://github.com/taotao135791-bit/toushou/releases/download/v2.3.1/TouShou-x64.exe) |

测试版 **[2.4.0-beta.5](https://github.com/taotao135791-bit/toushou/releases/tag/beta-v2.4.0-beta.5)** 已发布，提供 macOS 与 Windows x64 安装包：沿用已有模型、MCP、账户及项目，支持真实数据和可刷新看板。先退出正式版，再打开「投手 Beta」；已有看板自动导入兼容副本，后续独立保存。安装与回退说明见 [Beta 文档](docs/beta-release.md)。下方正式版限制与最新正式发版记录仍对应 v2.3.1。

macOS：打开 DMG，将投手拖入「应用程序」。应用尚未公证，首次打开若被拦截，可右键点击应用并选择「打开」。Windows：运行安装程序；若 SmartScreen 拦截，可选择「更多信息」后继续安装。

V2 使用流程与限制见[多平台读数](docs/multi-platform-readings.md)和 [HTML 看板说明](docs/v2-html-board-evaluation.md)。

## 快速上手

1. 打开投手，按提示安装或连接 Agent 运行时，并在设置中选择模型。
2. 需要分类保存时，从侧栏或输入框创建项目；未选项目时使用默认保存位置。
3. 在「连接」中授权需要的服务。TikTok 和 AppsFlyer 使用官方授权；Meta Ads 通过第三方 Pipeboard MCP 只读连接，Google 通过支持的报表入口读取。
4. 在「今日」选择账户及日期后查看读数；需要进一步分析时，在对话中向投手提问或保存读数到看板。
5. 使用看板和文件功能时，核对来源、数据与权限提示，再确认需要的本机更改。

读取广告报表本身不调用大模型；主动发起 AI 分析或编辑可能产生模型费用。AI 输出的文字结论需要人工复核。

## 使用限制

- AppsFlyer 可读取授权应用和 TikTok 渠道聚合事件；活动关联不等于事件或归因口径相同。命名数据集仍有共享名称、全局刷新与结果完整性限制，详见[接入说明](docs/appsflyer-connection.md)。
- Meta 授权和数据访问经过第三方 Pipeboard；看板日期范围使用本机日历，可能与账户时区不同。读数尚未与广告后台逐项核对，详见 [Meta 接入说明](docs/meta-ads-connection.md)。

- Google 真实账户验收暂缓；链接读取支持的页面和报表口径有限，详见[多平台读数](docs/multi-platform-readings.md)。
- 自选日期最长 366 天；AI 分析及布局生成最多发送所选范围内 50 个账户。快照和图表不会自动刷新，汇总数据不包含每日趋势。
- 主动使用 AI 时，所选账户名称、ID、数值和用户描述可能发送给所选模型；请勿在描述中填写密钥。匿名导出会隐藏内置账户标识，但自定义文字和数值仍需检查。AI 编辑的首次格式修复可能产生额外用量。
- 看板使用独立存储并保留旧版文件与迁移备份；降级后两版后续修改不会自动合并。当前不提供托管分享链接。
- macOS 系统或内置浏览器仍可能显示钥匙串提示；遇到问题请先取消并检查系统设置，不要直接重置默认钥匙串。

## 最新发版

**v2.3.1** 修复项目目录仍存在却显示不可用、恢复后红色错误残留的问题；补全原路径、原因和重新选择入口，统一项目与历史会话的状态检查。旧记录无法核验时，首次升级后需重新选择原文件夹确认一次，原有会话保留。完整记录见[更新日志](CHANGELOG.md)。

## 开发

开发需要 Node 22+ 和 pnpm。首次启动会检测 Agent 运行时。

```bash
pnpm install
pnpm dev
pnpm typecheck
pnpm test
pnpm build
```

运行时兼容性测试使用 `pnpm test:omp`；带凭据的 `pnpm test:omp:live` 不属于默认发布流程。安全边界见[安全模型](docs/security-model.md)，贡献与发版约定见 [AGENTS.md](AGENTS.md)。
