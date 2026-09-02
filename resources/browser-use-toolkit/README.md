# 浏览器操纵工具 (toushou-browser-use)

投手内置的 browser-use 能力：Agent 通过白名单动作驱动应用内浏览器面板——
导航、源码快照（优先）、真实输入事件点击/输入/滚动、渲染截屏（兜底）。

## 组成

- `extensions/index.ts` — 注册 browser_* 工具，经本机回环桥（env `TOUSHOU_BROWSER_USE`，令牌在路径中）与 GUI 通信
- `skills/browser-use/SKILL.md` — 操作纪律与"源码优先、截图兜底"策略

## 安全设计

- 桥只绑 127.0.0.1，请求需携带随会话下发的一次性令牌
- 动作为封闭白名单；**通道上从不传输脚本源码**，GUI 侧将动作映射为自己的提取/交互代码
- 读写分级：导航/快照/截屏为 read；点击/输入为 write（Ask 模式下需用户逐个批准）
- 截图落盘于 userData/browser-use，数量有上限
