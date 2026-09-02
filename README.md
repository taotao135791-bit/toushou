# 投手

桌面原生广告优化师 Agent。

投手把一位资深投放优化师装进原生桌面应用：规划投放、分析数据、诊断漏斗、迭代素材、输出报告，每一步都基于你的真实数据给出具体、可执行的下一步动作，而不是泛泛的建议。

## 下载安装

当前版本 v0.3.1，前往 [GitHub Release 页面](https://github.com/taotao135791-bit/toushou/releases/tag/v0.3.1) 下载：

| 平台 | 在线下载 | 大小 | SHA-256 |
| --- | --- | --- | --- |
| macOS（Apple Silicon） | [下载 DMG](https://github.com/taotao135791-bit/toushou/releases/download/v0.3.1/TouShou-arm64.dmg) | 见 Release | 见 Release |
| macOS（Intel） | [下载 DMG](https://github.com/taotao135791-bit/toushou/releases/download/v0.3.1/TouShou-x64.dmg) | 见 Release | 见 Release |
| Windows（x64） | [下载 EXE](https://github.com/taotao135791-bit/toushou/releases/download/v0.3.1/TouShou-x64.exe) | 见 Release | 见 Release |

v0.3.1：修复 macOS 未签名包应用内更新时错误判定安装位置无效的问题，用户无需使用终端命令即可完成更新。

v0.3.0：右侧工具面板升级为项目工作台；按当前项目展示文件树和源码预览，补充加载超时、失败提示、重试和完整路径；浏览器与 Office 继续按需打开，减少默认占用；完善工作台的无障碍标签。

v0.2.9：修复未配置 Developer ID 的 macOS 包无法通过代码签名校验的问题；临时签名包改用应用内下载、解压和重启替换，保留签名包的原生更新链路。

v0.2.8：修复 Windows `.cmd` 进程树退出后的文件锁残留，确保兼容性测试和应用关闭都能彻底清理子进程。

v0.2.7：使用跨平台命令启动适配层修复 Windows `.cmd` 参数转义，覆盖聊天、登录、配置、模型探测、包管理与兼容性测试。

v0.2.6：修复 Windows 下 `.cmd` 启动器的子进程执行，覆盖聊天、登录、配置、模型探测、包管理与兼容性测试。

v0.2.5：修复 Node 在 Windows 下执行 npm `.cmd` 启动器的兼容性判断，确保 OMP 兼容性套件真实执行。

v0.2.4：修复 Windows CI 兼容性测试的 shell 环境变量传递，确保 Windows 兼容性检查和发布稳定完成。

v0.2.3：修复 Windows CI 对 npm 全局安装的 OMP 启动器使用绝对路径，确保 Windows 兼容性检查和发布稳定完成。

v0.2.2：修复 Windows CI 使用 npm 安装的 `omp.cmd` 启动器，恢复 Windows OMP 兼容性发布门禁。

v0.2.1：修复 Windows 兼容性测试对 8.3 短路径的误判，恢复全平台发布流水线。

v0.2.0：浏览器与 Office 改为对话时按需从右侧工作区打开；右侧工具面板仅在聊天页显示；插件不支持的 UI 请求改为安静提示；更新器支持应用内重试、下载、安装和定期检查；增加单实例保护。

v0.1.3：新增应用内更新提示与 Windows 更新通道；内置 Google App Campaign 广告文案工具包；新增右侧工具面板和插件一键启动。

v0.1.2：新增内嵌浏览器面板与网页版 Office 表格（本地 xlsx/csv 打开与另存），扩展可通过 open_panel 通道被动打开面板；看板支持 design.md 样式定制与对话确认同步；插件接口规范统一并新增应用内指引。

v0.1.1：流式输出渲染提速（消息增量微批合并、按会话订阅、历史消息不再重复解析），并收敛了前端重复写法。

安装方式：

- **macOS**：打开 DMG，把"投手"拖入"应用程序"。应用未做公证，首次打开若被拦截：右键点击应用 → **打开** → **打开**，或在终端执行 `xattr -cr /Applications/投手.app`
- **Windows**：双击 `TouShou-x64.exe` 按引导安装。安装包未签名，SmartScreen 提示时选择"更多信息" → **仍要运行**

## 核心能力

**广告优化师 Agent**

- 每个会话自动注入优化师人格：预算分配、出价策略、人群与关键词、素材迭代、漏斗与归因诊断、效果报告
- 中文界面下默认中文回复，建议贴合平台政策与你的真实数据
- 会话持久化：重启不丢，侧栏历史一键恢复完整上下文
- 消息队列与中途转向：Agent 工作时继续输入，排队自动执行
- 检查点回滚：每次提问前对工作区做 git 快照，可回滚到任意一步，不影响你的暂存区与分支
- 逐工具审批：Ask 模式下 bash / 编辑 / 写入先询问再执行，支持单次允许、始终允许、拒绝
- 变更面板：工作区改动一览，逐文件 diff，新增文件自动合成

**模型与运行时**

- 服务商登录与密钥全部由运行时管理，界面不保存任何密钥
- 模型选择只列出运行时真正可用的模型，切换精确到当前会话
- 思考深度（off 到 max）跟随模型能力列表，设置页单独管理默认值

**效率工具**

- 插件系统：搜索安装、拖拽启停、本机编写 TypeScript 扩展
- 看板（Boards）：自由布局的小组件墙，支持导入 CSV / XLSX 数据集
- `@` 模糊引用文件、图片粘贴与附件（最多 4 张、单张 10MB）
- 中英双语界面、明暗主题、会话导出 HTML、后台完成时系统通知

## 快速开始

环境要求：macOS、Node 22+、pnpm。

```bash
pnpm install
pnpm dev
```

首次启动会自动检测 Agent 运行时；未安装时可一键安装，或复制终端命令手动安装。运行时的版本与配置信息在应用"设置"中查看。

## 开发

```bash
pnpm typecheck   # 类型检查
pnpm test        # 单元测试
pnpm build       # 构建
pnpm package     # 打包桌面应用
```

## 目录结构

```
src/main        Electron 主进程：进程管理、RPC 传输、IPC、安全边界
src/renderer    React 渲染层：对话、插件、看板、设置
src/shared      主进程与渲染层共享的类型与纯逻辑
resources       内置审批扩展等资源
docs            架构与协议文档
```

## 安全模型

- 渲染层沙箱隔离（contextIsolation + sandbox），无 Node 访问
- 文件访问基于能力授权（grant），路径经 realpath 校验，符号链接无法越界
- 工作区授权只在主进程签发，渲染层只能持有不透明 id
- 详见 [docs/security-model.md](docs/security-model.md)

## 底座说明

投手基于一套成熟的开源桌面 Agent 宿主深度定制，继承了其会话、检查点、插件与看板能力；运行时相关信息统一在应用"设置"中呈现。
