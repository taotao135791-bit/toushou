# Settings / Authentication / Models — Runtime Compatibility

OMP GUI does not own Oh My Pi configuration — it **exposes** it. This file
records which interface owns what, verified against
`@oh-my-pi/pi-coding-agent` **17.2.12** and legacy Pi **0.80.3**. The pure
RPC wire protocol lives in `docs/protocol-facts.md`.

## Sources of truth

| Domain | Current Oh My Pi (17.x) | Legacy Pi (≤ 0.84) |
|---|---|---|
| Credentials | runtime-owned store; managed via RPC `login` / `omp auth-broker` | `~/.pi/agent/auth.json` |
| Provider list | `omp auth-broker list --json` registry (pure CLI, no runtime spawn; `authenticated` layered on from RPC `get_login_providers`, falling back to the credential-filtered `omp models --json` when the probe is unusable) | static GUI list + auth.json keys |
| Model catalog | `omp models --json` / RPC `get_available_models` (credential-filtered) | registry file + `get_available_models` |
| Default model | `omp config modelRoles.default` (empty/absent = automatic) | `settings.json` `defaultModel` |
| Enabled models | `omp config enabledModels` (separate allow-list, not modified by OMP GUI) | — |
| Default thinking | `omp config defaultThinkingLevel` (enum: auto/minimal/low/medium/high/xhigh/max) | `settings.json` `defaultThinkingLevel` |
| Machine skills | `omp config skills.enableAgentsUser` (boolean; unknown ≠ enabled) | `settings.json` `skills` override list |
| Custom providers | `~/.omp/agent/models.yml` (GUI-managed: baseUrl + key + models; every write is verified against `omp models --json` and rolled back when omp does not recognize the provider) | — |
| GUI settings | electron-store (theme, language, notifications, …) — GUI-owned | same |

The GUI never writes `auth.json`/`settings.json` for the current runtime,
and never reads `agent.db`/`models.db`/`config.yml` directly — storage
location is not a public API. The one deliberate exception is
`models.yml`, which IS omp's public interface for custom providers
(docs/models.md): the GUI writes it atomically and verifies every change
against the real runtime.

## Authentication flow (current)

**API-key saves go through `models.yml` override entries** (`providers.<id>.apiKey`),
not the RPC login flow. omp's auth resolution ranks this above env vars and the
vault, and an override-only `{apiKey}` entry suffices for built-in providers
(verified live, omp 17.2.7). Every save is verified twice: presence via
`omp models --json` (the provider's models appear only when omp accepted the
entry AND resolved a credential) and, when the endpoint is known, a live
401/403 probe against the provider's model-list endpoint — both roll the file
back on failure. Removal clears the override entry and best-effort the vault
(`omp auth-broker logout`).

The interactive RPC `login` flow remains for `AUTH_START_LOGIN` only:

```
login
  → extension_ui_request open_url   (the provider's "API keys" dashboard URL)
  → extension_ui_request input      ("Paste your X API key", 10 min timeout)
  → extension_ui_request notify     ("Validating API key…")
  → response {success} | {success:false, error}   (provider-validated)
```

`open_url` is NOT a login step — it merely points at where to obtain a key.
The GUI does not auto-open a browser; it renders the paste-key input as the
primary action and offers the dashboard URL as an optional "Get API key" link.
Key entry is exactly the same direct paste-key form Oh My Pi itself uses.

- A successful login **persists** (verified: restart without env vars keeps
  the provider authenticated) and takes effect for new sessions.
- Logout rides the official `omp auth-broker logout <provider>` CLI.
- Every GUI write/login/logout is **read-after-write verified**: after the
  operation the runtime is re-queried, and a state it does not confirm is
  shown as failure, never as "saved".
- Zero-auth bootstrap: RPC mode refuses to start with no credentials at
  all. The GUI then spawns its probe with a placeholder env key for one
  provider with a static model catalog (deepseek, verified) — and masks
  exactly that provider's reported `authenticated` back to false, because
  the placeholder is not real auth.

## Models

- The picker lists what the runtime can actually run
  (credential-filtered catalog), never a static copy.
- **Scope is strict and separate:**
  - Composer picker WITH a session → switches exactly that session
    (`set_model`, session scope).
  - Composer picker WITHOUT one → a one-shot override consumed by the next
    session's spawn args (`--model` / `--thinking`).
  - Settings default model → `modelRoles.default` via `omp config`, applies
    to new sessions only. `enabledModels` is a separate allow-list and is
    NEVER written by the GUI's default-model path.
  Changing one never moves the other — verified by real-binary regression
  tests (a session hot-switch never moves `enabledModels`; a fresh session
  starts on the runtime default).
- `model_changed` / `thinking_level_changed` events keep pickers in sync
  with the runtime-resolved state.

## Thinking levels — two DIFFERENT domains

**Session thinking** (`set_thinking_level` / `--thinking`) uses the session
enum: `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`. `off` is
legal here — it is a session runtime state, never the global default.

**Default thinking** (`omp config defaultThinkingLevel`) uses the config
enum: `auto`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max` (verified
against 17.2.12). `auto` is legal; `off` is NOT. The GUI keeps these as
separate TypeScript types (`SessionThinkingLevel` vs `DefaultThinkingLevel`)
so a session enum value can never be written to global config.

Per-model subsets exist (`omp models --json` → `thinking: [...]`) and both
pickers filter by the current model's capability list. The Settings default
picker additionally keeps `auto` offered regardless of model metadata, since
`auto` is a runtime-side classifier, not a model capability.

`set_thinking_level` never errors — unsupported levels are **clamped**
(e.g. xhigh → high) or resolve to "auto" (unknown values). The GUI
therefore displays the runtime-resolved level (`thinking_level_changed` /
`get_state.thinkingLevel`), not the requested one. Scope mirrors models:
session picks are session-only; the Settings default applies to future
sessions only.

## Machine skills

`skills.enableAgentsUser` reports a boolean. The GUI reads it as a separate
three-state (`enabled` | `disabled` | `unknown`) — a missing/non-boolean
read-back is `unknown`, which is NEVER rendered as an explicit ON toggle.
Capability (whether this OMP version exposes the key at all) is likewise
reported separately in the capabilities overview; an unsupported version
shows "Not supported by this Oh My Pi version" and disables the toggle.

## Secrets

- API keys travel renderer → main → runtime only; the GUI never persists
  them, logs them, or echoes them back to the renderer.
- Settings only knows `connected | not connected`; no key material, not
  even masked (the runtime's own validation errors already mask keys).
- Login URLs are opened only from the runtime's login flow and only for
  `https:` (plus loopback `http://127.0.0.1|localhost` launch URLs).

## Known limitations (documented, not worked around)

- **Project trust** has no current-runtime equivalent; the row is shown on
  the legacy profile only.
- **Model catalog browsing without any credentials** is limited to
  providers with a static catalog — the runtime builds its catalog from
  authenticated providers.
- **Live permission-mode switching** (ask ↔ full) applies to new sessions
  on the current profile; there is no runtime RPC for it mid-session.
