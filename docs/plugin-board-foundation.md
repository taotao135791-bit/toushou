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

Malformed cosmetic fields in stored board documents are dropped while the
valid widget/board data stays usable. Conversational style commands instead
reject invalid tokens or unknown fields before saving the whole operation.
Neither path allows CSS, URLs, scripts, or renderer code through style fields.

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

Plain assistant text is not a mutation protocol. The explicit fence proposals
below still require their Apply action. Separately, the bundled boards toolkit
can perform structured local-board operations through the loopback bridge,
subject to Main validation and the current session's write authority. A user's
already authorized board request does not require a second confirmation merely
because the assistant uses this tool path. Readonly sessions cannot apply it.

### 4.1 Candidate: conversational generation and customization

The trusted Main prompt entry point records the accepted user turn and its
revision. `board_build_begin` freezes supported explicit constraints from that
request, not from model-supplied check arguments. Board writes require its
`buildId`; writes, datasets and AF recipes stay in an isolated draft. Preflight
reports current data/adapter feasibility without claiming that a platform lacks
the capability. Commit checks the frozen requirements, native-query evidence,
current authority and a conservative whole-store CAS, then synchronously
publishes all three stores under a crash-recovery journal. A superseded turn
or failed check cannot publish. This finite request extractor covers supported
grain, structure, date, standard measures and explicit fixed values; it is not
a general guarantee of arbitrary natural-language understanding.

Source proof is produced by actual Main query paths, not by a dataset name,
model text or imported headers. Explicit fixed snapshots are allowed; existing
presentation-only edits preserve original data without forcing a new fetch.
Outside generation, source queries and existing-board refresh retain their
normal behavior. Draft responses say `published:false`; only a successful
commit produces the saved-board delivery.

The default business-board guidance is a fallback for requests without a
specific direction: refreshable data, real date-grain trends, current-business
stages, concise analysis, third-party/source correspondence, and a table for a
daily report. Explicit purpose, style, structure, references, removals and
follow-up changes take precedence. Templates are starting points; custom
boards may start blank and are not forced back into default coverage or order.
Application IDs, media-source names and event mappings come from the current
task's discovered/confirmed scope, never another customer's examples or test
fixtures. Connecting an account does not establish a business-event mapping.

`board_create` accepts optional board style and `masterScope`; add/update
operations accept bounded widget style and layout. `board_customize` provides
a version-1 presentation patch for multiple existing widgets:

- `preview` defaults to true and returns changes plus the proposed board
  without saving; applying uses `preview:false` and normal write authority.
- `expectedUpdatedAt` must match the saved board. Main validates the entire
  patch, rejects stale revisions, unknown fields, invalid style tokens,
  out-of-grid geometry and newly introduced overlaps, and saves atomically.
- Only supplied titles, layout/style fields and optional `masterScope` change.
  Restyling preserves widget config, data bindings, untouched widgets and the
  current date scope. `null` clears a style override; omitted fields retain it.
- `masterScope` uses the existing today/yesterday/last3/last7/last30 presets and
  synchronizes native readers. Saving a scope does not execute its queries;
  the media and saved attribution queries must be pulled for the actual dates.

The global design-file proposal in §5 remains a separate, user-applied path.
Per-board style overrides do not rewrite global defaults. Native board tools
return saved identity and revision; chat verifies the board before showing a
saved-result/open-board card instead of inventing an HTML preview.

### 4.2 Candidate: live data widgets and readonly acceptance

`table` binds one dataset and supports selected columns, sorting and paging;
it is not a cross-source live join. `funnel` binds 2–12 named stages to real
dataset metrics and optional field filters; stages can use different datasets,
but cross-source ratios do not establish same-user conversion. `analysis`
recomputes up to three descriptive highlights from a bound metric and optional
dimension. These facts include period values, first-to-last date changes and a
leading group, not causal explanations. A static note does not refresh itself.

All three modules use current bindings and the module's resolved date scope.
`dateScope` is omitted/inherit, lookback anchored to the report end, or an
absolute historical window that remains refreshable. A yesterday report can
therefore keep one-day totals and a separately queried seven-day trend. Main
resolves all dates once per refresh; the renderer, source labels and acceptance
use that same result. A single date point does not establish a history trend.

`board_refresh` and renderer refresh share the Main planner. Compatible TikTok
reads share a coverage query, then use immutable verified source slices. AF
scope policies use separate stable materializations of one recipe; they never
overwrite each other's dates. These internal caches do not consume the 20 user
dataset slots. Relative dates, recipe changes, revoked authority and changed
board configurations invalidate an old run. Native Meta reads use the existing
authorized connector and the selected account; missing selection is an explicit
configuration state, not permission to guess an account.

`board_check` is readonly, including recipe reads with migration disabled.
`mode:"default"` checks fallback coverage; `mode:"custom"` (the default)
checks only explicitly declared `required` capabilities, with `daily:true`
also requiring a table. It inspects saved bindings, metric/date columns,
source state and available campaign-key evidence. Explicit grain requests can
add `granularity` (account/campaign/adgroup/ad/creative, one or an OR-list)
and up to 12 exact `dimensions` column names (all required together in the same
visible table or chart projection). When both are supplied, the same projection
must satisfy the grain and dimensions. Checks use visible columns or actual
grouping and current valid IDs, not titles or hidden report fields. Omitted
grain requirements do not impose a custom layout. Only
`ok:true, passed:true, status:"ready"` passes. Incomplete coverage or unresolved
evidence returns `ok:false, passed:false`, a stable error, `missing` and
`issues`; fix them and recheck, or report the actual blocker. Passing is not
proof of live-network availability, numerical platform reconciliation or an
unrequested capability. The checker does not itself refresh data.

Agent generation starts with `board_build_begin`. Main captures the original
accepted user turn and freezes supported requirements; subsequent board writes
must carry that build ID and are redirected to private board/data/recipe stores.
Ordinary list/get/check reads remain available without a build, including in a
readonly session. A build's check cannot weaken its frozen requirements by
omitting parameters. `board_build_commit` independently rechecks actual source
evidence, scope, the captured turn and permissions, then publishes the stores
with whole-store compare-and-swap and a recovery journal. Failed or superseded
work does not produce a saved-board result card. Existing explicit fixed
references and utility boards remain usable; newly generated business values
require source bindings unless the user explicitly requested a fixed snapshot.

### 4.3 Beta rollback compatibility

With the Beta release channel, board stores live in `board-beta-v3` beneath the
same application data directory. First access atomically imports the board,
dataset, AF-recipe and HTML-board stores and retains board-only initial backups.
Credentials and model/runtime settings remain in their existing location.
Later Beta writes do not modify stable's stores, and stable writes are not
automatically merged into the Beta overlay. Beta results remain available for
a future explicit compatible migration; the overlay is not disposable test
storage.

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
   human confirmation for this global-default proposal path. The independent
   structured per-board tool path is governed by §4.1 and session authority.

## 6. Board cards proposal (```board-cards) and live file cards

The board-cards protocol (`shared/boardCards.ts`, the data-card sibling of §5)
provides a versioned fence proposal with a preview, explicit Apply action,
Main validation and fixture tests:

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
  the normal atomic boards save. The fence itself cannot write boards.

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
