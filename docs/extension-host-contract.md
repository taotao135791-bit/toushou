# Extension Host Contract

**Status:** current host behavior and the baseline for future GUI extensibility.
This is not a promise that every upstream OMP/Pi extension API is implemented
by OMP GUI. It defines the narrow boundary this desktop host currently offers.

## Two different things called “plugin”

| Thing | What it is today | What it may do |
|---|---|---|
| **Native OMP/Pi package** | A package installed and run by the OMP/Pi runtime. It can contain extensions, skills, prompts, or themes. | Use the upstream OMP/Pi package API and send normalized RPC events to the host. |
| **GUI contribution** | **Not implemented.** There is no GUI manifest, registry, route contribution, widget contribution, or renderer bundle loader. | Nothing yet. A future API must be designed and versioned before this is enabled. |

The package-management screen manages native runtime packages; it is not a
marketplace for arbitrary Electron/React modules. Native package installation
does not grant code access to the OMP GUI renderer, window.electronAPI,
Electron APIs, app routes, sidebar items, board widgets, or local persistence.

Third-party React/JavaScript is never injected into the desktop renderer. The
only current presentation bridge for a native package is the constrained
extension_ui_request RPC protocol below.

## Runtime compatibility policy

The host determines a session profile from the runtime handshake, not from a
package's claimed version:

| Profile | Detection | Transport policy |
|---|---|---|
| **Current OMP** | A ready frame advertises supported protocol versions. | Use the highest mutually supported RPC version (currently v1/v2); use v1 directly when it is the only shared version, or fall back to it if v2 negotiation is rejected or times out. |
| **Legacy Pi** | No ready frame; the first ordinary frame settles the profile. | Use the legacy v1 JSONL surface. |

No shared protocol version is a visible compatibility failure, not a silent
fallback. The broader extensionUi capability shown by the app means that a
responsive runtime was found; it is **not** a per-method guarantee. Extension
authors must tolerate unsupported host methods and should use upstream feature
detection/timeouts rather than infer support from a binary name or version.

The host applies the same bounded UI subset whenever either profile emits a
compatible frame. Profile-specific runtime behavior remains the upstream
runtime's responsibility. Verified protocol facts and versions live in
protocol-facts.md.

## Supported host UI messages

Native packages send an upstream frame shaped like:

~~~json
{ "type": "extension_ui_request", "id": "request-id", "method": "…" }
~~~

Interactive requests are answered only after the user acts. The host writes:

~~~json
{ "type": "extension_ui_response", "id": "request-id", "value": "…" }
~~~

or one of { "confirmed": true|false } and { "cancelled": true }.

| Method | Host behavior | Response |
|---|---|---|
| select | Modal choice list. | Selected value, or cancelled. |
| confirm | Modal confirmation. | confirmed: true/false, or cancelled. |
| input | Single-line modal text input. | value, or cancelled. |
| editor | Multiline modal editor, optionally prefilled. | value, or cancelled. |
| cancel | Dismisses the matching pending interactive request. | No additional response is invented. |
| notify | Adds a bounded system message to the transcript. | None. |
| open_url | Adds an explicit, user-mediated external link to the transcript. | None. |
| open_panel | Opens a built-in host panel (see below). | Immediate success ack when the request carries a valid id. |

### open_panel: fire-and-forget host panels

An extension can ask the host to surface a built-in panel without any user
gesture choreography:

~~~json
{ "type": "extension_ui_request", "id": "request-id", "method": "open_panel",
  "panel": "browser", "url": "https://example.com/report" }
~~~

Params are validated in Main before anything is shown:

| Param | Rule |
|---|---|
| `panel` | Required; one of `"browser"` or `"office"`. Unknown panels are rejected. |
| `url` | Required for `panel: "browser"`; must be an http(s) URL the in-app browser panel may load (no credentials, no control characters, at most 2048 chars — the same validator the panel applies at load time). |
| `path` | Required for `panel: "office"`; a string of at most 1024 characters without NUL. Before anything is shown, Main revalidates it with `validateOfficePath` (src/main/officeFile.ts): the path must `realpath` to an existing regular file with a `.xlsx` / `.xls` / `.csv` extension, at most 20 MB. |

Semantics:

- **Fire-and-forget.** The host answers well-formed requests immediately with
  `{ "type": "extension_ui_response", "id": "…", "success": true }` (only when
  the request carried a valid id) and never blocks the turn on user action.
- **Bounded.** A session accepts at most 30 open_panel requests; excess
  requests are refused with a visible recoverable error and receive no ack.
- **No privilege.** open_panel cannot navigate the main window, inject
  renderer code, or pick targets outside the two named panels. The browser
  panel itself is a sandboxed, preload-free native view with an in-memory
  session; popups from it are denied and safe URLs are rerouted to the system
  browser.
- **Office grant minting.** For `panel: "office"` the raw `path` never
  reaches a renderer. After `validateOfficePath` passes, Main mints one
  short-lived (10-minute), single-use read FileGrant per target window
  (`mintOfficeFile` in src/main/operationGrant.ts, purpose `office-open`) and
  broadcasts `{ panel: "office", office: { grant, name } }`. The office page
  exchanges the grant for a parsed workbook snapshot over the `office:read`
  IPC; consumption verifies the owning renderer, expiry, and the file's
  on-disk identity (realpath + dev + ino) at read time. Saving back is a
  separate, user-authorized "save as" flow with its own one-shot write grant
  (`office-save`) minted by the native save dialog — extensions cannot write
  through open_panel.

Malformed panels/URLs/paths produce a recoverable host error and no ack.

The dialog remains visible if Main cannot write its answer to the runtime; the
renderer must not pretend the request completed. Dialogs use modal semantics,
initial focus, Escape-to-cancel, focus trapping, and a displayed timeout.

### URL rule: a user gesture is mandatory

An extension cannot open a browser by emitting open_url. The host accepts only
HTTPS URLs, or HTTP URLs on localhost/127.0.0.1 for local OAuth-style flows.
It renders a plain warning and link; only the user's click asks Main to open
the system browser. The browser boundary validates the URL again and rejects
custom schemes, file:, data:, javascript:, malformed URLs, and
credential-bearing URLs.

launchUrl is an optional preferred target and instructions is displayed as
plain transcript text. Neither field grants a navigation or popup exemption.

## Explicit unsupported behavior

The following upstream UI requests are **not** implemented as GUI APIs:

- setStatus
- setWidget
- setTitle
- set_editor_text
- any unknown extension_ui_request.method

The host does not silently claim success and does not manufacture an
extension_ui_response. It emits one visible system diagnostic per unsupported
method per session, then continues processing the runtime stream. Extensions
must not block waiting for an answer to a fire-and-forget or unsupported
method.

Malformed request ids/URLs and invalid request shapes produce a recoverable
host error and no dialog. Duplicate ids are ignored. A session accepts at most
20 unresolved interactive dialogs; excess requests are rejected visibly.
Host-side payload bounds intentionally truncate text/options before they reach
the renderer (for example: 200-character ids, 2,000-character titles, 100
options, and a 24-hour maximum timeout).

## Security and ownership rules

- The renderer is not an extension sandbox or plugin runtime. It renders only
  the core application's own code.
- Main owns response delivery, URL validation, and the runtime session ledger.
  A renderer state update is not evidence that an upstream response was sent.
- Installing a native runtime package is a trust decision about code that runs
  in OMP/Pi. It does not expand the desktop host API beyond this contract.
- Do not add a hidden, package-specific IPC endpoint. Any new host capability
  must be explicit, typed, capability-gated in Main, documented here, and
  tested in protocol/session tests.

## Before adding GUI contributions

Future GUI extensibility must be a separately versioned GUI Extension API,
not an accidental consequence of native package installation. Its design must
include at least:

1. a signed/identified manifest with host API version and compatibility range;
2. declarative, schema-validated contribution points rather than arbitrary
   React injection;
3. explicit per-contribution permissions and a Main-side capability gate;
4. lifecycle, disable/uninstall, migration, and failure-isolation behavior;
5. contract tests, compatibility fixtures, and a documented upgrade policy.

Until those pieces exist, use a native OMP/Pi package and the supported host
UI subset only.

## See also

- `plugin-interface-spec.md` — install sources, manifest shape, extension API
  surface, and known limitations of native runtime packages.
