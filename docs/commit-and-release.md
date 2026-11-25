# Mac 和 Windows 并行开发与提交指南

两端共用一个源码仓库和一条 `main`。日常开发在功能分支完成，合并后的主线包含两端的改动。发布目标只决定这次生成哪些安装包、哪些用户看到更新。

## 开发者如何提交

1. **开工。** 先运行 `git status --short` 确认本地改动，再从最新远端主线创建分支。例如，处理 Windows 安装问题可以运行：

   ```sh
   git fetch origin
   git switch -c fix/windows-install origin/main
   ```

2. **同步昨天开的分支。** 先提交已完成的本地修改，再在自己的功能分支合入最新主线。这一步也适用于 Mac 开发者。若两人改了同一段逻辑，核对两个改动的预期行为，解决冲突后重新测试。

   ```sh
   git fetch origin
   git merge origin/main
   git diff --stat origin/main...HEAD
   ```

3. **检查并提交。** 按文件暂存本次修改，用 `git diff --cached` 检查提交内容。提交说明写明修复或新增的行为，如 `fix: preserve window focus after installation`。业务开发分支的版本号由发布者在准备正式版时统一更新。示例、日志和截图使用合成数据。

4. **验证并开 PR。** 执行 `pnpm typecheck`、`pnpm test` 和 `pnpm build`，涉及 OMP 协议、配置或运行时兼容时再执行 `pnpm test:omp`。推送功能分支并以 `main` 为 PR 目标。说明改动影响哪个平台、在哪个系统实测，以及测试结果。共享代码的改动应覆盖两端的相关行为。合并前如遇主线新增相关改动，重新同步和验证。

## 由发布者选择平台

每次正式发布使用全仓唯一且递增的版本号。发布者在一个提交中更新 `package.json` 的 `version`、`toushouReleaseTarget`、`CHANGELOG.md` 和对应的 `docs/releases/vX.Y.Z.md`，然后将提交合入 `main`。

| 本次交付 | `toushouReleaseTarget` | 应用内更新 |
| --- | --- | --- |
| Mac 专项修复 | `macos` | Apple Silicon 和 Intel 用户获取该版 |
| Windows 专项修复 | `windows` | Windows x64 用户获取该版 |
| 两端都要交付 | `all` | 两端分别获取适合自己系统和架构的安装包 |

举例：双端都在 2.9.8 时，Mac 可以单发 2.9.9，Windows 仍为 2.9.8。随后 Windows 开发者合入昨天分支上的修复，Windows 可以单发 2.9.10。该安装包包含此时主线里所有适用于 Windows 的改动。Mac 会一直使用 2.9.9，直到有下一次面向 Mac 的发布。

## 如何发正式版

1. 在 GitHub Actions 的 **Release → Run workflow** 中选择分支和 `all`、`macos` 或 `windows`，可以先单独做打包预检。正式发布由推送版本标签触发。
2. 确认发布提交已进入最新 `origin/main`，检查该提交的版本、平台和 CI 结果。从已经过验证的主线提交打标签。下面以过渡版为例，后续发版替换为本次版本号。

   ```sh
   git fetch origin --tags
   git log -1 --oneline origin/main
   git show origin/main:package.json
   git tag -a v2.9.8 origin/main -m "投手 v2.9.8"
   git push origin refs/tags/v2.9.8
   ```

3. 在 **Release** 工作流中核对本次选中的平台。每个目标都要完成测试、打包和成品启动检查。工作流将安装包上传到草稿，回下载校验，通过后才公开并更新对应的平台版本。
4. 在[正式版下载页](https://github.com/taotao135791-bit/toushou/blob/release-channels/README.md)核对两个版本号及下载链接。单端发版时，另一端应仍指向原来那一版。确认后记录工作流链接、发布结果及适用平台，更新主线的版本说明。

## 旧版用户和失败重试

2.9.7 使用 GitHub 的 `releases/latest` 寻找更新。双端 2.9.8 保留在这个入口，使长期离线的老用户也能先升级到过渡版。2.9.8 及后续稳定版从 `release-channels` 分支读取各平台版本；安装包保存在各自的 `vX.Y.Z` 发布页。开发和开 PR 都基于 `main`，渠道分支由发布工作流维护。

如果测试、打包或校验失败，到失败的 Actions 运行查看日志。临时故障可以对同一标签选择 **Re-run failed jobs**。若已看到正式 Release 而下载页尚未更新，重跑该发布流程中失败的渠道更新步骤，随后核对两端版本。若源码确实需要修复，修复合入主线后另取递增版本号，保留已发布标签和安装包供用户核验。
