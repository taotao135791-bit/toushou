# 钉钉连接

## 登录与验证

1. 在投手打开「连接 → 钉钉」，点击「钉钉账号登录」。投手会复用兼容的官方钉钉 CLI，首次缺少客户端时会自动下载并校验官方发行文件。[钉钉 CLI 官方发行](https://github.com/DingTalk-Real-AI/dingtalk-workspace-cli/releases/tag/v1.0.69)
2. 如果浏览器打开钉钉授权页，选择组织并授权。组织还没开通 CLI 访问时，按授权页提示向管理员申请。通过后回到投手重新点击登录。[钉钉官方授权说明](https://github.com/DingTalk-Real-AI/dingtalk-workspace-cli/blob/main/README_zh.md#开始使用)
3. 投手自动验证连接并显示账号和组织。可以点击「检查连接」复验，也可以在投手对话中输入「在钉钉里搜客户群消息里的周报」或「找标题有投放复盘的钉钉文档，打开我指定的那份」。查询范围由授权账号的权限决定。[钉钉官方命令文档](https://open.dingtalk.com/dingtalk-dev/wiki)

## 日常使用

- 如果本机已经登录钉钉 CLI，投手会直接验证并连接该账号。连接成功后，投手固定使用这次确认的账号和组织。退出或切换终端的默认账号后，投手仍按已绑定的身份验证。
- 投手对话支持搜索消息、搜索文档和读取文档。账号授权由钉钉 CLI 保存，投手只记录绑定的账号和组织标识。断开投手连接后，CLI 的现有授权仍可供其他程序使用。
- 使用 v2.7.0 机器人方式的用户升级后，需要点击「钉钉账号登录」完成一次新的授权。[v2.7.0 连接历史](https://github.com/taotao135791-bit/toushou/blob/v2.7.0/docs/dingtalk-connection.md)

连接卡片的图标取自钉钉官网首页引用的 PNG。[钉钉官网](https://www.dingtalk.com/) · [官网图标](https://gw.alicdn.com/imgextra/i3/O1CN014ZbI6ZTEhdC0ttN2_!!6000000003783-2-tps-444-444.png)
