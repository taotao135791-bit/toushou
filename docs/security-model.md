# Security Model

This file records the actual trust boundaries of OMP GUI. It is intentionally
plain about what is protected and what is not — no "fully sandboxed / zero risk"
claims.

## Runtime boundary

Oh My Pi is the **only** agent runtime. The GUI never spawns an agent, never
calls a model, never runs a tool, and never persists a session transcript
itself. It is a desktop host that:

- owns the `omp|pi --mode rpc` child process,
- normalizes the wire protocol (`src/main/omp/OmpProtocol.ts`),
- projects runtime events into UI state (`src/renderer/lib/execution.ts`),
- persists only GUI-owned metadata (`electron-store`), never OMP credentials.

## Renderer trust

The renderer is treated as **not fully trusted**:

- `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`
  (`src/main/index.ts`). No Node access in the renderer.
- The renderer talks to the host only through the typed `contextBridge` API
  (`src/main/preload.ts`). There is no `invoke(command, args)` escape hatch.
- Payloads from the renderer are re-validated in main: prompt images
  (`src/main/imageValidation.ts`), subagent selectors, session names, etc.

## Workspace authorization

Filesystem authority is a **capability granted by Main**, not a path chosen by
the renderer.

```
User / trusted session
        ↓
      Main
        ↓
  WorkspaceGrant  (id + realPath + displayPath + source)
        ↓
     FsGuard
        ↓
Git / Files / OMP Session
```

- `WorkspaceGrant` objects are minted only by Main (`src/main/workspaceGrant.ts`)
  from trusted sources:
  - the native folder dialog (`workspace:select`),
  - a re-validated persisted recent workspace (`workspace:activate-recent`),
  - a validated existing session cwd (`workspace:activate` with `source: 'session'`),
  - a trusted runtime cwd.
- Main canonicalizes the path with `realpath` and registers the canonical root
  with `FsGuard`.
- The renderer can only pass a **grant id** to workspace-sensitive IPC handlers.
  It cannot pass an arbitrary absolute path. If a grant id is unknown/expired,
  the handler rejects the call.
- `FS_SET_ROOT` is deprecated and no longer grants authority. `setFsRoot` in the
  preload API is a stub that always returns `false`.

## Workspace-sensitive IPC

The following IPC handlers require a valid `WorkspaceGrant.id` and resolve the
real path internally:

- `omp:create-session`, `omp:resume-session`, `omp:list-session-history`,
  `omp:delete-session-file`
- `git:info`, `git:file-diff`
- `fs:list-project-files`
- `fs:list-dir` and `fs:read-file` (grant id + relative path)

Checkpoints operate on the live session's already-granted `cwd`.

## Symlink containment

A path that is lexically inside a workspace is not trusted until symlink
resolution proves its real path is also inside:

- **Workspace roots** (`src/main/workspaceGrant.ts`): the canonical `realPath` is
  registered with `FsGuard`; a selected symlinked workspace works transparently
  because authority is tied to its target.
- **FsGuard reads/writes** (`src/main/fsGuard.ts`): every target is resolved with
  `realpathSync`; an in-workspace symlink pointing outside is denied.
- **Git changes** (`src/main/gitinfo.ts`): untracked-file line counts and
  synthetic diffs resolve real paths; an in-workspace symlink pointing outside
  is shown as `symlink → outside workspace`, never read through.
- **Session history** (`src/main/historySessionGrant.ts`): listing converts
  Main-only file records into opaque ids bound to the requesting `webContents`
  and workspace grant. Resume/delete revalidate the file's canonical
  path/device/inode and exact generated session directory for that workspace;
  a `session.jsonl -> /outside/file` symlink (or a replacement file) is never
  resumed/read/deleted.
- **Package manifests** (`src/main/packages.ts`): `pi.*` resource paths are
  checked lexically **and** by `realpath`, so a package symlink cannot smuggle
  resources from outside the package dir.

## Session storage boundary

OMP owns durable session transcripts under `~/.omp/agent/sessions` (or the
isolated `PI_CODING_AGENT_DIR` in tests). The GUI reads them read-only for
history/resume and reconstructs metadata/agents from the active branch only
(`src/main/sessionMetadata.ts`). A GUI sidecar is not used for execution truth.

The history-list API returns only `HistorySessionDescriptor` values (`id`,
title, timestamp, uuid), never a durable transcript path or header cwd. The
opaque id expires, is revoked on workspace/window teardown or history refresh,
and is valid only with the same active workspace grant and renderer that
listed it.

Historical agent records are reconstructed from OMP's durable `task` tool
results. Background/async agents end up in the same `task` result format; the
reconstruction layer upserts by agent id so a later final result overrides an
earlier empty/spawn record. Running state is never claimed from durable data
alone — only live `get_subagents` or lifecycle events can show an agent as
running.

## External URL policy

- Auth/open-URL flows use `shell.openExternal` only for `http(s)` URLs, and the
  installer downloads only from an HTTPS host allowlist (`omp.sh` / GitHub),
  refusing redirects to untrusted hosts (`src/main/installer.ts`).

## Package-code authorization

Installing or upgrading a package is a code-trust decision. The renderer never
receives an installed package's CLI source, scope, command target, or on-disk
path. Instead, `packages:list` maps each Main-owned `PackageInfo` row to a
short-lived `PackageDescriptor` id (`src/main/packageActionGrant.ts`).

- Remove/update/enable/disable accept only that opaque id. Main binds it to the
  listing `webContents`, re-lists and exact-matches the internal source/scope
  before dispatch, and serializes one mutation per row.
- Local folder/file selections and Finder drops become separate
  `PackageLocalSourceGrant` ids. Their canonical realpath/device/inode remains
  in Main and is checked again after confirmation.
- Every install, update, remove, enable and disable action requires an
  Electron-owned native confirmation. Renderer content can request the dialog,
  but cannot silently accept it or select a different command argument.
- Package CLI logs are redacted for known source/path spellings and URL
  credential fragments before they return to the renderer.

## Installer trust model

The auto-installer runs remote code, so its boundary is explicit:

- HTTPS-only, host allowlist, redirect-host validation, redirect cap, script
  size cap.
- The child process receives a **minimal** environment (PATH/HOME/SHELL/… only)
  — provider keys, `GITHUB_TOKEN`, `AWS_*` etc. are never forwarded.
- Failures surface an exit code + a safe stderr summary, never environment
  values.
- The pinned compatibility gate installs an exact version from the official npm
  package (`@oh-my-pi/pi-coding-agent@<version>`) and verifies `omp --version`
  matches before running tests. The canary job tests the latest release but does
  not block merges.

## Credential handling

The GUI does not store Current OMP credentials. Provider auth goes through the
runtime's native login flow; keys live in the runtime's own store. GUI metadata
(`electron-store`) never contains API keys, OAuth tokens, or credentials.

## RPC capability semantics

A capability is a runtime fact, not a UI guess:

- a `success` or a non-"Unknown command:" `success:false` proves the command
  exists (`supported`);
- only `Unknown command: X` marks it `unsupported`;
- a timeout / transport failure / death leaves it `unknown` (never downgrades a
  known state).

## Release signing

Unsigned (ad-hoc) development builds are separate from signed/notarized
releases. Signing/notarization is env-var driven (`CSC_LINK`,
`APPLE_ID`, …) and only active when configured — certificates and passwords are
never committed. See `README.md` and `.github/workflows/release.yml`.
