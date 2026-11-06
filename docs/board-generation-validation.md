# Board generation validation — 2.4.0 Beta

Validated on 2026-11-06. This is a candidate validation record, not a release or
a claim that generation succeeds for every request. Earlier candidate findings
are retained below rather than replaced by later successful runs.

## Method

- Used the real DeepSeek Flash provider with thinking disabled, the registered
  tool schemas, Main dispatch, board validation, query recipes and local
  persistence.
- Replaced upstream media and attribution responses with synthetic fixtures in
  isolated temporary profiles. No customer identifiers, source readings,
  credentials or raw transcripts belong in this document or the repository.
- Ran each scenario twice. Inspected saved widgets, source bindings, dates and
  the independent completion check instead of accepting the assistant's final
  message as evidence of success.
- This checks generation and application integration. It does not measure live
  platform accuracy, production latency, every model or every possible layout.

## Beta implementation and revalidation

The Beta replaces voluntary completion checks with a Main-owned build:
accepted user turn → frozen supported requirements → private draft → actual
query evidence → independent commit validation. Board/data/recipe publication
uses whole-store compare-and-swap and a recovery journal. Ordinary readonly
queries and explicit utility-board edits keep their normal workflows.

Main now computes all source windows. A yesterday report can query yesterday's
metrics/table/funnel and a separate seven-day history ending on that report
date. TT coverage is queried once for compatible widgets; AF uses stable scope
slots without consuming the user's dataset quota. Recipe changes, date changes,
session revocation and a new user turn prevent an old result from being treated
as current. Native Meta reads use the existing authorized connector and require
an actual selected account; an unavailable source is not replaced with zeros.

The first fresh Beta batches ran these eight scenarios twice using the real
model and the authorized Main bridge, with synthetic upstream responses:

| Scenario | Runs | Actual result |
|---|---:|---|
| Explicit numeric snapshot | 2 | Two numeric cards, correct fixed values, no source reads, committed as requested. |
| Yesterday daily report plus historical trend | 2 | One-day totals/details and separately refreshed seven-day history passed the frozen check and committed. |
| Undirected commerce board | 2 | Source-backed business modules passed and committed. |
| Blue/white table only | 2 | Committed a table-only board without adding default funnel/analysis cards. |
| Dark trend and two metrics | 2 | Committed the requested layout and palette, preserving live bindings. |
| Restyle existing board | 2 | Preserved widget identities, data bindings and dates while changing appearance/placement. |
| Unavailable ad/creative grain | 2 | No substitute board published; frozen grain validation prevented campaign-level delivery. |
| Attribution unavailable | 2 | No incomplete board published and no invented attribution values. |

All 16 of these runs met their expected outcome; the four source-blocked runs
are correct refusals to publish, not successful data deliveries. A subsequent
four-run extension passed both subscription-product defaults and exposed a
host-entry bug in both attribution-only trend requests: their wording did not
contain the word "board". The build entry was corrected to accept a captured
nonempty generation request without depending on that keyword, while retaining
readonly inspection protection. The original failures remain part of this
record; the attribution-only task is retested separately after the fix.
Both fresh attribution-only retests then passed and committed exactly one live
event-trend chart, without media readers or fallback modules. Thus the 20-run
Beta batches initially met 18 expected outcomes, and the two entry failures
passed in separate retests after the host fix; they are not relabeled as
first-attempt successes.

Additional deterministic regressions cover readonly board listing, explicit
module removal, utility boards, a fixed snapshot converted to live data,
visible grain plus requested measures, spoofed imported data, quota exhaustion,
same-ID event-query changes, failed reads and interrupted publication. This is
a bounded varied sample, not a guarantee of arbitrary natural-language
understanding or every customer-specific event mapping.

## Earlier candidate findings

The initial core batch contained 16 runs: 14 with available synthetic sources
and two with an intentionally unavailable attribution source.

| Scenario | Runs | Observation |
|---|---:|---|
| Undirected commerce and subscription boards | 4 | Two initially passed; two had incorrect attribution query windows. Both repaired successfully after the check returned the exact requested dates. |
| Single-day daily report with historical trend | 2 | Tables, business stages and source-backed widgets were saved; a single date point correctly failed the historical-trend check. |
| Explicit blue/white table only | 2 | Preserved the requested table-only structure and palette. |
| Explicit dark trend with two metrics | 2 | Preserved the requested structure and dark palette, without adding the default funnel/table. |
| Attribution-only event trend | 2 | One initially passed; the other repaired its query dates successfully. An attribution-only custom board does not require a media comparison. |
| Restyle existing board | 2 | Preserved board/widget identities, data configs and date scope while changing appearance and placement. |
| Attribution unavailable | 2 | Retained an incomplete result and reported the source failure without inventing attribution values. |

With the stricter final evidence rules, nine of the 14 source-available saved
results initially passed. Three date failures subsequently passed in separate
repair continuations. Those repairs are not counted as first-pass successes.
The two daily-report historical-trend cases were a capability gap in that
earlier candidate; the Beta's independent module windows address it.

An additional four boundary runs tested explicit fixed snapshots and unavailable
creative/ad granularity. Both snapshot runs respected fixed values and avoided
source reads; one chose notes instead of numeric cards, and both omitted the
custom completion check. One creative request correctly stopped when the
required columns were unavailable. The other incorrectly delivered campaign
data despite the user's explicit constraint. That result is a generation
failure, even though its generic data/table check returned ready.

The candidate now adds explicit grain/visible-dimension evidence to the check,
requires strong source constraints to be preserved, prefers numeric cards for
explicit numeric snapshots, and asks the agent to complete a custom check
without forcing live-data capabilities on a snapshot. A generic ready result
must never be used to claim that an unverified user-specific constraint passed.

After those changes, a fresh targeted batch repeated commerce defaults,
subscription defaults, numeric snapshots and unsupported creative grain twice
(eight runs, with a bounded 24 model turns per run). Five completed the full
requested workflow. The other three observations remain recorded:

- One subscription default ended with attribution dates differing from the
  board scope after spending turns repairing overlapping layout proposals.
  The saved board correctly failed its final check.
- One fixed snapshot saved exactly the requested two numbers without reading
  sources, but incorrectly requested live `data` in its custom check. This was
  a workflow/communication failure, not missing snapshot content.
- One unsupported creative request still created a campaign-level reference
  board without permission to substitute it. The new grain check correctly
  returned `granularity-unverified`, and the assistant reported incomplete.
  Detecting the error does not make the unwanted substitute acceptable.

The snapshot tool guidance was then clarified with an explicit empty
`required:[]` example and the distinction between fixed numbers and live data.
Two further fresh snapshot runs both saved numeric cards and passed the correct
custom check. These two are a separate retest, not replacements for the earlier
failure. There is no basis to claim uniform generation reliability from this
small, deliberately varied sample.

## Current boundaries

- A module's independent history must be queried and displayed with its own
  actual dates. Changing a whole daily report to seven days is not a valid
  substitute for yesterday's totals plus a historical trend.
- Native tables bind to one dataset. Separate media and attribution tables are
  live; an independently refreshable cross-source joined table is not yet a
  supported native operation.
- Required creative/ad grain must be proved by real visible IDs and values.
  Campaign IDs, titles and explanatory notes cannot stand in for that data.
  The Beta's frozen commit check prevents an unsupported fallback draft from
  becoming a published board.
- Matching campaign keys establishes a relationship between source rows. It
  does not establish identical attribution windows, event definitions or values.

## Application validation

The final local Beta baseline passed TypeScript checking, 2,654 unit/integration
tests (two skipped), 24 OMP compatibility tests and the production build.
Subsequent focused checks passed for the report-date suffix, snapshot guidance
and final table palette/date-wrapping adjustments. Electron fixtures
exercise actual renderer behavior for refresh/date switching, native table and
funnel data, custom palette inheritance, and saved-board delivery/navigation.
Only synthetic profiles are used by these fixtures.

Existing production boards, datasets and query recipes are kept unchanged by
these tests. The separately authorized production test board remains available
for inspection. The Beta uses existing real connection/model/project settings;
board/data/recipe/HTML-board results are stored in a versioned local overlay
initialized from the existing data, so the old release cannot discard unknown
new widget types. This is durable working storage, not synthetic test mode.

Publication is gated by the Beta workflow's clean dual-platform build, pinned
OMP suite, packaged startup/save/restart checks and uploaded-asset checksum
verification. The public release notes include the exact workflow and commit
links. These notes do not assert a live production-platform reconciliation.
