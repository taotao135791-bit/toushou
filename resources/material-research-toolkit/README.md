# 素材研究成文 (toushou-material-research)

把 MCP 素材服务（如 SocialPeta）和飞书文档串成一条流水线：
检索广告素材 → 分析整理 → 写入飞书文档交付；并按标准产出可执行的素材需求文档。

## 组成

- `skills/material-research/SKILL.md` — 全流程 SOP 与前置检查（含未连接引导标记约定）
- `skills/creative-requirements/SKILL.md` — 素材需求文档标准：项目事实确认、批次层级、图片/视频表格字段、文案与合规、SocialPeta 检索去重、飞书原生附件、回读核验
- `prompts/material.md` — `/material` 命令入口（工具面板一键可用）
- `prompts/creative-requirements.md` — `/creative-requirements` 命令入口

## 依赖

- MCP 素材服务：在投手"连接"页添加（粘贴服务商给的 MCP 配置或令牌）
- 飞书：连接页扫码，需 docs.write 权限

未连接时助手回复中的 `[[connect:mcp]]` / `[[connect:feishu]]` 标记会渲染为
就地引导卡，一键直达连接页。
