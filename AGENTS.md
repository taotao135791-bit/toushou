# OMP GUI working agreement

This file is for both human contributors and coding agents. It keeps parallel
work reviewable and preserves the Electron security boundary.

## Start every change safely

1. Read the task, this file, and the relevant document in `docs/`.
2. Run `git status --short`; do not overwrite another contributor's work.
3. Keep one branch/PR focused on one user-visible behavior or one foundation
   concern. Coordinate before changing a shared contract.
4. Never put API keys, tokens, user transcripts, local paths, or packaged
   application output in source control.

## 团队雷达强制预检（Team Radar gate，低打扰设计）

本仓库由多人并行开发。coding agent 在任务开始时，对本次计划改动的目录
（范围级，不是逐个文件）执行一次冲突预检：

    node tools/team-radar/agent.js --check <目标文件或目录> --server http://<雷达服务地址>:8787

按退出码执行。原则：只在"同文件并发修改"时打断用户，其余情况不打扰：

- 0：范围内无并行修改。静默继续，无需向用户提及本次预检；
- 2：范围内存在同文件并发修改。这是唯一需要暂停的情况：向用户报告冲突
  成员与分支，用户确认（如回复"继续"）后立即放行，同一范围内不再重复询问；
- 3：属于受保护路径（tools/team-radar/redline.json）。正常继续开发，
  仅在方案或 PR 说明中标注"合并前需对应负责人审核"，无需停下询问；
- 1：预检服务不可用。向用户报告一次后继续开发，不阻塞进度。

频率约定：每个任务开始时检查一次；仅当扩大改动范围（进入新的目录）时补查。
任务内的连续编辑、保存、重构均在首次预检范围内，无需重复检查。

## 意图中台强制上报（Intent Hub gate，开工前）

雷达按文件探测，本台按意图协调：vibe coding 无法预知 AI 会改哪些文件，
因此每个 coding agent 在**任务开始前**先申报"要做什么"，先到先得拿锁：

    node tools/intent-hub/cli.js --user <花名> --title "<一句话说明功能或 bug>" \
      --scope <目录1> [目录2 …] --branch <分支>

默认走 Tailscale MagicDNS 设备名（http://leoliumacbook-air:8788，团队
成员入网即达，无需另行告知地址）；--server 可覆盖。

按退出码执行：

- 0：绿灯，意图已登记（24 小时有效）。静默开工，无需向用户提及；
- 2：红灯，他人已持相似或范围重叠的意图（先到先得）。停止本次修改，
  向用户报告持锁人（花名/意图/分支），等用户指示；用户明确让行或原意图
  关闭后，重新申报再开工；
- 1：服务不可达。向用户报告一次后继续，不阻塞开发。

收尾约定：任务合并后执行 `--close <id>` 关闭意图释放锁；同一任务不重复
申报；范围扩大（进入新目录）时重新申报并带上完整范围。

## Architecture contracts

The trust direction is:

```text
Renderer → typed preload API → IPC validation in Main → OMP/runtime or disk
```

- The renderer is not a security authority. New privileged work belongs in
  Main, with validation there.
- Do not add a generic "run command" or arbitrary-path IPC method. Use
  capabilities/grants minted by Main.
- A contract change normally touches its shared type, IPC channel, preload API,
  Main implementation, renderer caller, and tests together. Do not leave a
  one-sided API behind.
- OMP protocol changes belong behind the normalisation layer in
  `src/main/omp/`; the renderer should not branch on raw runtime protocol
  frames or runtime versions.
- Native-package and future GUI-extension changes must follow
  `docs/extension-host-contract.md`. Do not treat package installation as
  permission to inject renderer code or add a hidden IPC surface.
- Treat changes to `src/main/`, `src/shared/`, `src/main/preload.ts`,
  `electron-builder.json`, and `.github/` as high-impact. Ask for review from
  the corresponding code owner.

## Parallel-work boundaries

Prefer a vertical slice under one feature area over edits to global files:

- runtime and security: `src/main/omp/`, `src/main/lib/`, `src/main/ipc.ts`
- host contracts: `src/shared/`, `src/main/preload.ts`,
  `src/renderer/types/`
- renderer features: `src/renderer/pages/`, `src/renderer/components/`
- release and policy: `.github/`, `electron-builder.json`, top-level policy
  documents

If two changes need the same central file, agree on the contract first and
make one owner responsible for the final integration. Do not solve merge
conflicts by silently discarding either side's behavior.

## Required validation

Run the narrowest relevant tests while developing, then run the applicable
baseline before handoff:

```bash
pnpm typecheck
pnpm test
pnpm build
```

For a runtime/protocol/settings change, also run:

```bash
pnpm test:omp
```

Use `pnpm test:omp:live` only with explicit approval: it can consume provider
tokens. Do not run it against a contributor's real credentials by default.

## Handoff standard

Every pull request or agent handoff states:

- the user-visible behavior changed;
- files and contracts intentionally changed;
- commands run and their results;
- known limitations, follow-ups, or decisions still required.

Use conventional, imperative commit subjects when commits are requested.
Keep generated output (`dist-electron/`, `release/`, `node_modules/`) out of
commits.

## Things that require explicit maintainer approval

- changing GitHub branch rules, repository permissions, or release secrets;
- selecting or changing the project license;
- publishing a package/release or uploading user data;
- weakening Electron, IPC, filesystem, updater, or extension permissions;
- destructive migrations of user-owned data.
