# Contributing to OMP GUI

Thanks for helping build OMP GUI. This repository is an Electron desktop host
for Oh My Pi, so reliability, runtime compatibility, and the renderer-to-main
security boundary are part of every feature—not separate cleanup work.

## License status

This repository does not currently declare an open-source license. Do not
assume permission to redistribute it or reuse its code outside this repository.
Before inviting external contributors or accepting redistributed forks, the
project owner should select and commit an appropriate license. This is a legal
and product decision for the owner; it is intentionally not inferred here.

## Local setup

Use the pnpm version pinned in `package.json`; Corepack/pnpm will read that
field automatically.

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm dev
```

Node.js 22 is used in CI. See `README.md` for the supported development
commands and `AGENTS.md` for the repository working agreement.

## Contribution workflow

1. Search open issues and existing pull requests before starting.
2. Open an issue for a material change, especially one affecting IPC,
   persistence, extensions, security, or release behavior.
3. Branch from an up-to-date `main`; use a focused branch and pull request.
4. Describe the behavior change, migration/compatibility impact, and test
   evidence in the PR template.
5. Resolve review comments without force-pushing over another contributor's
   work.

Keep unrelated formatting, refactors, generated artifacts, local test data,
and credential changes out of feature pull requests.

## Definition of done

Before requesting review, run:

```bash
pnpm typecheck
pnpm test
pnpm build
```

Changes under `src/main/omp/`, settings/authentication, protocol handling, or
runtime compatibility must also run:

```bash
pnpm test:omp
```

Do not run `pnpm test:omp:live` unless a maintainer explicitly asks you to: it
can use provider credentials and consume tokens.

Add or update tests for behavior changes. For UI changes, include a short
manual verification path (keyboard and error/loading states included) until
the planned Electron E2E suite is in place.

## Contract and security changes

Renderer code is not trusted to grant filesystem or process authority. If your
change crosses the renderer/Main boundary, update the typed contract and
validate it in Main. Do not add arbitrary shell, arbitrary-path, or generic
IPC escape hatches.

Changes to these areas need explicit code-owner review:

- `.github/`, `electron-builder.json`, release/update configuration;
- `src/main/`, `src/shared/`, `src/main/preload.ts`;
- Workspace grants, filesystem access, external URL handling, credentials,
  extensions, and OMP protocol compatibility.

Read `docs/architecture.md`, `docs/security-model.md`,
`docs/protocol-facts.md`, and `docs/extension-host-contract.md` before
changing the related domain.

## Pull-request policy to enable in GitHub

The following are the intended `main` branch rules. They require a repository
administrator to configure them in GitHub; this document does not silently
change remote settings.

- require pull requests and one approving review;
- require review from Code Owners for owned paths;
- require the `Typecheck · Test · Build`, `Secret scan`, and
  `OMP pinned compatibility` checks;
- dismiss stale approvals after new commits;
- require branches to be up to date before merge;
- block force pushes and direct pushes to `main`;
- allow squash merge by default and enable automatic deletion of merged
  branches.

The `OMP latest canary` job is intentionally advisory and should not be a
required check.

## Release process

1. Land the release PR on `main`, including the intended `package.json`
   version and release notes.
2. Confirm required CI checks are green.
3. Create and push a matching tag, for example:

   ```bash
   git switch main
   git pull --ff-only
   git tag vX.Y.Z
   git push origin vX.Y.Z
   ```

4. The Release workflow verifies that the tag is exactly `v` plus the package
   version, reruns typecheck/tests/runtime compatibility, packages both macOS
   architectures, writes SHA-256 checksums, and creates or updates the GitHub
   Release assets.

Do not manually upload a partial set of updater assets. The workflow validates
the DMGs, ZIPs, update manifest, and blockmaps before publishing.

## Security reports

Never include secrets, API keys, unredacted logs, or a public proof of concept
in a normal issue. Follow `SECURITY.md` instead.
