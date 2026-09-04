# 飞书连接集成

v0.4.0 的飞书连接位于 `src/main/integrations/feishu/`，主进程是唯一可信边界。

## 连接流程

1. Renderer 只调用类型化的 preload API；它拿到的是连接状态和一次性二维码 URL。
2. Main 调用 PersonalAgent registration provider，向 `accounts.feishu.cn` 或 `accounts.larksuite.com` 发起 `begin / poll / cancel` 设备码流程。
3. 扫码确认后，App ID、App Secret、owner open_id 和 OAuth token 使用 Electron `safeStorage` 加密保存到 `userData/feishu-credentials.bin`，不会进入 `electron-store`、Renderer 或 OMP。
4. Main 使用 `@larksuiteoapi/node-sdk` 建立 WebSocket。私聊要求 owner，群聊要求 @机器人；SDK 去重、队列和断线重连之外，Router 还会按消息 ID 做本地去重。
5. 每个聊天/线程映射到一个 OMP session。远程 session 创建时固定传入 `permissionMode: readonly`，所以飞书消息不会悄悄获得本地写文件、shell 或其他高风险权限。

## 工具边界

内置 `toushou-feishu-toolkit` 只暴露以下高层工具：

- 消息：send、reply、read、search
- 文档：read、create、append
- 表格：read、write、create
- 多维表：read、upsert、query

OMP 工具进程只拿到一个随机 token 的本机桥接 URL（`127.0.0.1`），请求动作经过 Main 白名单校验。桥接不接受任意 URL、脚本、文件路径或凭据。

消息使用机器人 App/tenant token。文档、表格和多维表在连接页按能力发起设备 OAuth；Main 使用 `withUserAccessToken` 将已授权用户令牌仅注入对应的用户范围 API 请求。授权不足时工具返回 `authorizationRequired`，不会自动打开浏览器或扩大权限。

## 手动应用

高级设置用于已有飞书/Lark 应用，格式为 `cli_...` 的 App ID 和 App Secret。密钥会直接提交到 Main 进程并立即写入系统安全存储；Renderer 清空 secret 输入框，界面只展示脱敏 App ID。

## 故障排查

- `二维码已过期`：在连接页重新生成二维码。
- `连接需要处理`：检查网络、飞书应用可用性和管理员审批，然后点击重试。
- 工具提示额外授权：在已连接卡片的“按需申请额外权限”中选择能力，打开授权链接后点击“检查授权”。
- 群里没有响应：确认消息中 @了投手；私聊没有响应时确认扫码账号就是 owner。
- 手动应用无法连接：确认应用启用了机器人能力、WebSocket 事件接收以及相应 Open API 权限。

SDK 的具体事件和 API 版本随锁文件固定；升级 SDK 时必须同步更新类型检查、连接测试和第三方声明。
