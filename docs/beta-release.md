# Beta 测试版发布

测试版与正式版并行安装。正式版仍使用 `v*` 标签和现有发布流程；测试版使用 `beta-v2.4.0-beta.5` 标签及独立的 `beta-release.yml`。不要为 Beta 创建 `v2.4.0-beta.5` 标签，该名称会触发正式发布流程。

## 安装与资料

- 应用名称为「投手 Beta」，应用标识为 `com.toushou.desktop.beta`，不会覆盖「投手」。
- Beta 沿用现有账户、项目和模型设置。应用资料仍在系统应用资料目录下的 `toushou`，Agent 继续使用现有 CLI 配置，无需重新连接。
- Beta 将已托管的内置工具包连接到当前应用资源位置，启动同步完成后才开放首个会话；主动停用、移除或自行安装的同名包不会被接管。
- 首次使用会将已有看板、数据集和 AF 查询配方复制到本机 `board-beta-v3` 兼容存储，保留初始数据副本；此后 Beta 的看板修改保存在该目录，不改写旧正式版看板文件，两版后续修改不自动合并。凭据不会复制到该目录。
- 打开 Beta 前先退出正在运行的正式版，两版对应用资料使用同一单实例锁。
- 回退 v2.3.1 时，旧版仍在后台恢复自己的工具链接；若首个会话工具尚未就绪，等待初始化后新建会话。旧版重链可能重新启用停用插件，回退后需核对插件开关；Beta 的启动等待和禁用保护不能改变已经发布的旧版代码。
- 明确传入 `--user-data-dir` 时，应用资料使用该目录，既有 `PI_CODING_AGENT_DIR` 和 CLI profile 环境保持不变。成品冒烟另外设置临时 HOME 与 Agent 目录，始终隔离真实资料。
- Beta 采用手动下载安装；应用内检查、下载和安装均不会进入正式版自动更新流程。设置中的发布页入口指向当前 Beta 标签。
- 当前 `beta-v2.4.0-beta.5` 提供 macOS Apple Silicon / Intel 的 DMG、ZIP 与 Windows x64 安装程序。Mac 成品由成功任务直接发布；Windows 复用同版源码已通过的单测与 OMP 检查，在独立任务中仅修正校验工具的两处平台路径后重新打包，成品启动、保存重启与公开文件回验均通过。尚未提供 Windows ARM64 包。

## 发布步骤

1. 在测试分支完成改动与 QA。更新 `electron-builder.beta.cjs` 中的版本及相应 `docs/releases/beta-v<版本>.md`，保持 `package.json` 和正式版下载说明不变。
2. 提交发布候选源码后，在最后提交上创建与配置严格对应的 `beta-v<版本>` 标签。标签不可移动。
3. 推送测试分支与 Beta 标签。`Beta Release` 分别执行全量类型、测试、构建和固定 OMP 兼容检查，再打包 macOS 两种架构与 Windows x64。
4. 流程核对真实架构、ASAR 内的版本/应用入口及 bootstrap 内容；使用显式隔离的合成资料启动成品，检查更新通道隔离和保存重启。测试不得引用本机正式资料。
5. 两个平台的 14 项文件须通过清单、SHA-512 和 SHA-256 检查。流程先创建 `prerelease` 草稿，上传后重新下载核验 SHA-256，再以 `prerelease=true`、`latest=false` 公开。
6. 核对公开 Beta 页面及文件，并确认 GitHub 的 `releases/latest` 仍指向正式版；补充本次真实 CI 链接与结果。

手动运行该工作流只做预检，不发布。普通构建不会生成或载入 Beta 入口；本地检查 Beta 打包路径可使用：

```bash
pnpm build
node tools/beta-release.cjs prepare
pnpm exec electron-builder --config electron-builder.beta.cjs --mac --arm64 --dir --publish never
node tools/beta-release.cjs verify-package 'release-beta/mac-arm64/投手 Beta.app/Contents/Resources'
```

`--dir` 仅验证本机包装路径，不能代替最后提交的双平台 CI 或成品启动测试。发布资产位于 `release-beta`，文件名以 `TouShou-Beta-<版本>-` 开头，清单为 `beta-mac.yml` / `beta.yml`；测试版资产中禁止出现 `latest*.yml`。现有 `.github/workflows/release.yml` 和 `electron-builder.json` 保持不变。
