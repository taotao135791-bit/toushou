# Security policy

## Supported versions

Security fixes are applied to the current development branch and the latest
published release. Older releases may not receive patches.

## Reporting a vulnerability

Please do **not** open a public issue containing exploit details, private user
data, API keys, session transcripts, or credentials.

Use GitHub's private vulnerability reporting for this repository when it is
enabled:

<https://github.com/taotao135791-bit/omp-gui/security/advisories>

If private reporting is not available, use the `Security contact request` issue
form. Include no technical details there; it exists only to ask a maintainer
for a private reporting channel. Repository maintainers should enable GitHub
private vulnerability reporting before accepting outside contributors.

Include, where safe:

- a concise impact statement;
- affected version/commit and platform;
- reproduction steps or a minimal proof of concept;
- mitigations already attempted;
- whether the issue exposes data, credentials, code execution, or privilege
  escalation.

Maintainers should acknowledge reports within seven calendar days, keep
details private until a fix is available, and credit reporters only with their
permission.

## In scope

High-priority reports include:

- renderer-to-main IPC privilege escalation;
- arbitrary file read/write or workspace-grant bypass;
- external navigation, updater, installer, or package-installation abuse;
- credential/token exposure or unsafe logging;
- extension/runtime protocol input that causes code execution or data loss;
- signing, release-asset, or update-manifest compromise.

Do not send provider credentials or customer data to reproduce an issue.
Rotate any credential accidentally disclosed to an issue, pull request, log,
or chat immediately.

## Secure development expectations

- Main validates all security-relevant input; renderer validation is only UX.
- New filesystem authority must be represented by a Main-issued capability,
  not an arbitrary renderer path.
- New external URLs are allowlisted and opened deliberately.
- Dependencies, workflows, updater metadata, and release assets are
  security-sensitive changes and require code-owner review.
- Secrets belong in local environment variables or GitHub Actions secrets,
  never in source, fixtures, screenshots, or release notes.

See `docs/security-model.md` for the current desktop-host trust model.
