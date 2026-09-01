# 谷歌广告文案工具 (toushou-ads-toolkit)

投手内置的 Google App Campaign 广告文案原生包。方法论源自
[ads-tool-factory-share-kit](https://github.com/unthinker69/ads-tool-factory-share-kit)，
将工厂的产品接入表、素材规格、五维评分体系与合规红线移植为对话内能力。

## 组成

- `skills/ads-copy/SKILL.md` — 文案生成方法论（接入 → 生成 → 评分 → 交付）
- `prompts/ads.md` — `/ads` 斜杠命令工作流

## 使用

对话中输入 `/ads`，或直接说"帮我写谷歌广告文案"。首次使用会先收集产品接入表。

## 安装（手动）

```sh
omp plugin install /path/to/ads-toolkit
```

投手会在启动时自动链接本包（见 src/main/bundledPackages.ts）；用户在插件页
卸载后不会被重新安装。

## 更新源（混合更新链路）

本目录是**离线保底副本**。最新内容以作者仓库为准：
<https://github.com/unthinker69/ads-tool-factory-share-kit>（根目录带同款
pi/omp 包声明，插件页搜索或粘贴仓库地址即可安装/更新到最新版；同名安装会
平滑替换本地链接）。给本目录同步上游改动后，请同时递增 package.json 的
version，让默认挂载逻辑刷新版本戳记。
