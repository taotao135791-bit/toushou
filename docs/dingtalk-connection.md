# 钉钉连接

「连接」页的钉钉入口位于飞书下方。投手使用钉钉官方 Stream 模式接收企业自建应用的机器人消息，桌面端连网即可使用，无需配置公网回调。[钉钉 Stream 协议](https://open-dingtalk.github.io/developerpedia/docs/learn/stream/protocol/)

## 接入与验证

1. 在投手「连接 → 钉钉」打开开发者后台，选择所属组织并创建企业自建应用。在「应用信息」复制 Client ID（AppKey）和 Client Secret（AppSecret）。[钉钉开发者后台](https://open-dev.dingtalk.com/)
2. 在「机器人与消息推送」启用机器人配置，选择 Stream 模式并发布。将自己的钉钉账号加入应用可见范围。[钉钉官方配置教程](https://open-dingtalk.github.io/developerpedia/docs/explore/tutorials/stream/bot/python/create-bot/)
3. 把两项凭证填入投手的钉钉连接表单。显示「待绑定」后，复制 `/pair` 命令。在钉钉里搜索刚发布的机器人名称并打开私聊，将整条命令发送给机器人。[钉钉官方私聊测试教程](https://open-dingtalk.github.io/developerpedia/docs/explore/tutorials/stream/bot/java/test-bot/)
4. 机器人回复绑定成功后，发送 `/ping`。收到「投手连接正常。」表示私聊收发已通。发一条文字问题验证模型回复，例如「花费 200 元获得 8 个安装，CPI 是多少？」。

## 日常使用

- 投手桌面端运行时会保持连接。网络恢复后会自动重连，也可以在「连接」页手动重试。应用退出后，下一次启动会读取保存的凭证并尝试恢复。
- 连接只接受已绑定账号在该机器人私聊中的文字消息。可发送 `/new` 从空白上下文开始。模型仅根据私聊中提供的文字回答，看板、广告账户和本地文件在桌面端操作。
- `/ping` 独立于模型设置。若能收到 `/ping` 回复但文字问题没有生成回复，请确认投手设置里的默认模型能用支持的 API Key 连接。仅通过 OAuth 授权的模型暂未接入钉钉对话。
- 更换钉钉账号时，在投手里断开连接并重新配对。断开会移除本机凭证和绑定。Client Secret 应保管在投手连接页与钉钉后台，配对命令仅发送给自己创建的机器人。

钉钉图标来自官网首页引用的原始 PNG。机器人回复使用钉钉签发的临时会话地址。[钉钉官网](https://www.dingtalk.com/) · [官网图标](https://gw.alicdn.com/imgextra/i3/O1CN014ZbI6ZTEhdC0ttN2_!!6000000003783-2-tps-444-444.png) · [钉钉机器人回复文档](https://open-dingtalk.github.io/developerpedia/docs/learn/bot/appbot/reply/)
