# Plugin and Board Foundation

This document is the maintenance contract for the two intentionally
user-extensible surfaces in OMP GUI: **native runtime plugins** and **local
boards**. It is written for contributors who may work independently on these
areas.

It does not turn either surface into a renderer-extension API. See
`extension-host-contract.md` for the hard boundary between native OMP/Pi
packages and OMP GUI itself.

## 1. Plugin intake and ownership

The Plugins page accepts three kinds of native runtime package source:

| User-facing form | Main-process normalization / action | Ownership |
|---|---|---|
| GitHub `owner/repository`, repository URL, or `/tree/<ref>` URL | Current OMP receives `github:owner/repository[#ref]`. Full non-GitHub git URLs remain intact. | Runtime owns installation. |
| npm name or versioned npm spec | Current OMP receives the ordinary npm spec; legacy `npm:` is normalized. | Runtime owns installation. |
| Folder/file chosen through the native picker | Main resolves a short-lived opaque grant; it never accepts a renderer-supplied filesystem path. | Runtime owns installation/link. |

“Handwritten plugin” is a separate managed-source path:

1. The renderer submits only metadata and TypeScript source.
2. Main validates it and writes an app-owned package below `userData` under an
   opaque UUID, using a staged directory swap.
3. **Save** changes source only. **Save & sync** / **Sync** requires an
   explicit GUI action and then calls the runtime's local-link mechanism.
4. **Delete source** asks for confirmation, unlinks the managed package first,
   then removes the source and registry entry transactionally as far as local
   filesystem semantics permit.

Never add a renderer IPC that accepts an arbitrary command, package path, or
write location. Do not auto-install, auto-link, or auto-update a native
package from model output.

### Supported versus intentionally unsupported

- Packages may use upstream OMP/Pi extension, skill, prompt, and theme
  facilities.
- They cannot contribute React code, routes, sidebar entries, raw board
  widgets, or unrestricted Electron APIs.
- A package's only current GUI bridge is the constrained
  `extension_ui_request` protocol described in `extension-host-contract.md`.

## 2. Kimi Computer Use bridge

Kimi CU is an optional, separately installed local desktop-control runtime. It
is not bundled, downloaded, or operated through UI click emulation by OMP GUI.

The bridge lifecycle is deliberately narrow:

1. Main detects the official macOS Kimi CU app and checks its service and the
   Accessibility/Screen Recording prerequisites.
2. Main opens its stdio MCP endpoint only for a bounded `initialize` plus
   `tools/list` health probe. It never exposes arbitrary Kimi tool calls to
   renderer IPC.
3. The Plugins page shows readiness and, for machines without Kimi CU, directs
   the person to install it themselves.
4. Enabling needs a native confirmation. It writes only OMP GUI's owned stdio
   entry, `omp-gui-kimi-cu`, into `~/.omp/agent/mcp.json`, preserving other
   entries. A malformed or externally modified collision is reported rather
   than overwritten.
5. Disabling removes only that exact managed entry, after confirmation.

The bridge is available to **new OMP sessions** after enabling. It must remain
obvious that a computer-use MCP server can inspect the desktop and send input;
the agent's normal permission mode still controls runtime behavior.

## 3. Board model and visual safety

Boards are locally persisted whole-board documents. Main validates every board
on read and write; renderer state is never trusted as persistence input.

`BoardWidgetStyle` is intentionally a token model, not a CSS escape hatch:

- colors are six-digit hex values only;
- corners and spacing are bounded integers;
- title alignment and shadow are small enums;
- board canvas supports only hex background plus `none`, `dots`, or `lines`.

Malformed cosmetic input is dropped while the valid widget/board data stays
usable. This supports substantial visual customization without allowing a
board JSON file to inject CSS, URLs, scripts, or renderer code.

When adding a new widget type, update together:

1. shared widget type, factory/defaults, and validation;
2. renderer gallery, body, config panel, and localized text;
3. Main persistence tests and shared-model tests;
4. board-chat summarization, if the new widget has meaningful context.

## 4. Board ↔ chat handoff

The integration is explicit in both directions.

| Direction | Behavior | Privacy / consent rule |
|---|---|---|
| Board → chat | **Ask agent** builds a bounded composer draft from board metadata, widget summaries, and dataset schemas, then navigates to chat. | It does not auto-send. Dataset rows and note bodies are excluded; the person can inspect/edit the draft. |
| Chat → board | An assistant reply offers **Add to board**. The person selects a board and confirms a note title before the reply is added as a note widget. | Assistant text never mutates a board by itself. The latest board is re-read before saving to avoid a stale-dialog overwrite. |

Do not introduce an opaque prompt parser that lets an assistant silently create
widgets, bind datasets, alter style, or delete boards. If a future structured
board-plan protocol is needed, it needs a versioned schema, a preview/diff,
per-operation confirmation, validation in Main, and fixture tests first.

## 5. Board design file (board-design.md)

Board appearance defaults live in a single Main-owned document,
`userData/board-design.md`, parsed and formatted by `shared/boardDesign.ts`.
The format is deliberately line-based and strict: `#`/`##` section headers
(`board`, `widget`), one `key: value` token per line, `> ` comments; unknown
keys are warnings and out-of-domain values are errors that drop the field.

The value domain is exactly the §3 token model — the parser reuses
`validateBoardStyle` / `validateBoardWidgetStyle`, so a design file can carry
six-digit hex colors, bounded radius/padding integers, and the small
titleAlign/shadow/grid enums, and nothing else. No arbitrary CSS, URLs, or
selectors can enter the renderer through this file.

Merge semantics at render time: the design supplies **defaults**, a widget's
or board's own `style` fields override it field by field, and anything neither
provides falls back to the built-in defaults. Persisted
`kanban-boards.json` documents are never rewritten when the design changes.

Two writer paths converge on the same Main entry point
(`boards:save-design`), which refuses to persist a document with parse errors:

1. The in-app design dialog (or any external editor — Main watches the file
   and broadcasts `boards:design-changed` so open boards follow).
2. Chat: the design dialog can prefill a bounded format brief
   (`buildBoardDesignPrompt`); the agent answers with one
   ```` ```board-design ```` fence, which the chat UI renders as a card showing
   the parsed tokens and issues. Clicking **Apply to boards** is the required
   human confirmation — this is the §4-compliant way an assistant may change
   board styling: proposal only, never a silent mutation.

## 6. Board cards proposal (```board-cards) and live file cards

The §4 requirement for "a versioned schema, a preview, per-operation
confirmation, validation in Main, and fixture tests" is implemented by the
board-cards protocol (`shared/boardCards.ts`, the data-card sibling of §5):

- The boards-page board menu prefills a bounded brief (`buildBoardCardsPrompt`)
  as a composer **draft**; the agent answers with exactly one
  ```` ```board-cards ```` JSON fence: `{ "version": 1, "cards": [...] }`,
  1–12 cards, each a bounded `metric` / `list` / `note` / `file` card.
- Parsing is strict about the envelope and lenient per card: unknown fields
  are dropped, an invalid card is skipped with a warning, and a proposal whose
  cards are all invalid fails to parse. File cards may reference
  workspace-RELATIVE `.png/.jpg/.html` paths only (no absolute paths, no
  `..`, enforced lexically at parse).
- The chat UI renders the fence as a preview card with a target-board picker;
  **Apply** sends the RAW fence text plus the board id over
  `boards:apply-cards`. Main re-parses with the same validator, resolves file
  cards against the named workspace grant (fsGuard realpath containment;
  unresolvable cards are skipped with a warning), rebuilds the cards into the
  existing widget model through the shared factories, and appends them via
  the normal atomic boards save. The agent can never write boards by itself.

Live file cards are the `file` widget type: the board stores only a
workspace-relative path (`.png/.jpg/.html`; unsafe paths are rejected by
board validation, and strict saves refuse a board carrying one). Content is
read through `boards:widget-file-read`, which resolves the path against the
ACTIVE workspace grant's canonical real path and re-checks fsGuard on every
read — images return as data URLs, HTML as text for a sandboxed iframe
(`sandbox="allow-scripts"`, deliberately without `allow-same-origin`).
Main watches each bound file (lazy per-directory watcher, 300 ms debounce,
same pattern as §5) and broadcasts `boards:file-changed`; the matching card
reloads, and fresh bytes per read are the cache-busting mechanism.

## 7. Contributor checklist

For any change touching these surfaces:

- preserve the `renderer → typed preload → IPC Main → runtime/disk` boundary;
- validate / normalize once in shared/Main, never only in React;
- keep dialogs keyboard-dismissible and make destructive/runtime changes
  explicitly confirmed;
- do not leak Main-held absolute paths or unrelated MCP configuration through
  preload;
- add focused tests for parsers, validation, and state transitions;
- run at least `pnpm typecheck` and the relevant Vitest suites before review.

## See also

- `plugin-interface-spec.md` — install sources, manifest shape, extension API
  surface, and known limitations of native runtime packages.
