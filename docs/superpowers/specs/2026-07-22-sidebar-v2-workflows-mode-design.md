# Sidebar v2 — Workflows Mode — Design (v2)

**Date:** 2026-07-22
**Status:** v2 after adversarial spec review (Grok 4.5 + GPT-5.6 Sol, both SHIP WITH FIXES). All MUSTs + agreed SHOULDs folded in. Each section notes the finding it resolves. Pending re-review of the reworked data-model + create-coordinator.
**Branch:** feat/sidebar-v2-workflows

## Motivation

Sidebar v2 (upstream #4026) is a flat, threads-only list — it renders **zero**
board/workflow entries. Users on v2 have no sidebar path to see, open, or
create a workflow board. This adds a **Threads / Workflows switch** below
search; in Workflows mode the sidebar shows a flat, v2-styled list of the
primary environment's boards across its projects, and the New-thread button
becomes an Add-workflow button with project selection.

## Scope decision that shapes everything (resolves Sol MUST-1/2/6, Grok multi-env MUSTs)

**v1 lists and creates boards for the PRIMARY environment's projects only.**
Rationale: boards are a primary-environment feature — `CreateWorkflowDialog`
already sources its agent/provider/model choices from the primary environment
(`CreateWorkflowDialog.tsx:165`), so offering a remote project's board creation
would present primary-only providers (Sol MUST-6). Restricting to the primary
environment also means **one** `listNeedsAttentionTickets` call (that env is
global within itself) and eliminates the cross-environment keying/fan-out
hazards. Rows are still keyed by `(environmentId, boardId)` for future-proofing,
but v1 has a single environment in play. **Cross-environment boards in the
sidebar are an explicit fast-follow.** "Board-capable project" therefore means
**a project belonging to the primary environment** — no capability predicate is
invented (there is none: Sol MUST-1); primary-env membership is the gate.

## Switch (resolves Sol SHOULD-10, Grok switch findings)

A `ToggleGroup` (Threads | Workflows) mounts as its own row in the header
cluster, ordered **search → switch → project-scope menu**. Controlled
`value={[mode]}`; empty/invalid `onValueChange` payloads are ignored (never
allow "no mode"), mirroring `DiffPanel.tsx:686`. The project-scope menu applies
to both modes; its label becomes mode-neutral ("Filter by project", was "Filter
threads by project", `SidebarV2.tsx:1517`).

**Persistence (resolves Sol SHOULD-13):** new
`ClientSettings.sidebarV2Mode: "threads" | "workflows"` with
`withDecodingDefault("threads")`, added to the full schema, the
`ClientSettingsPatch` `optionalKey` partial, the contract test, and the desktop
fixture — the exact pattern that added `renderHtmlEmbeds`
(`settings.ts:52,559`, `DesktopClientSettings.test.ts:15`; confirmed by both
reviewers). Mode is **not written back until client settings have hydrated**
(gate on `useClientSettingsHydrated()`), so the persisted value isn't clobbered
by a pre-hydration default write. Mode is only meaningful under Sidebar v2
(v1 keeps its per-project board rows).

**Mode-switch cleanup (resolves Sol SHOULD-9):** switching Threads → Workflows
clears external thread selection and cancels any in-progress row rename (v2
already clears selection when a scope change hides rows,
`SidebarV2.tsx:869`) — hidden thread rows must not stay actionable.

## Workflows list — architecture (resolves Sol MUST-2/3/4/SHOULD-11, Grok data-model MUSTs)

A dedicated **`WorkflowSidebarList`** component, mounted **only** when
`mode === "workflows"` (so its subscriptions exist only in that mode, and hook
ordering is never dynamic — Sol MUST-2). Inside it:

1. **Eligible projects** = primary-environment projects from `useProjects()`,
   further narrowed to the current project-scope (All vs one) **before** any
   atom is constructed (Sol SHOULD-11 — filter, then fan out).
2. **One memoized aggregate atom** reads the canonical
   `workflowEnvironment.listBoards({ environmentId, input: { projectId } })`
   atoms for each eligible project and the single
   `listNeedsAttentionTickets()` atom for the primary environment, and combines
   them — subscribed **once** via the established atom-registry read pattern (the
   same `registry.mount`/`subscribe` idiom used by `subscribeBoardRaw` /
   `useBoardApi`). Not `useEnvironmentQuery` inside a `.map()`.
3. **Aggregate state** exposes `{ boards: WorkflowRowModel[], pending: boolean,
errorsByProject: Map<ProjectId, error> }`:
   - Each eligible project's `listBoards` is one of loading / error / entries.
   - **Partial success is preserved** (Sol MUST-3): a project whose query
     _fails_ contributes an `errorsByProject` entry and a retryable inline
     error row; it does **not** blank the list.
   - `pending` is true while any eligible query is still loading.
   - Boards flatten to rows tagged `(environmentId, projectId, boardId, name,
filePath, entryError)`. `entryError` (a `BoardListEntry.error` — a
     discovered board that failed to _decode_) is distinct from a project-level
     query failure (Sol MUST-3): the former is a destructive-tone board row, the
     latter is a project error row.
4. **Attention join (resolves Sol MUST-7, SHOULD-12):** group the primary env's
   `listNeedsAttentionTickets()` rows (each carries `boardId`) by
   `(environmentId, boardId)` into a count + a **dominant attention kind** by
   this total precedence: `blocked > parked_issue > waiting_for_approval >
waiting_for_input > parked_waiting`, null when the board has no attention
   tickets. (There is **no** "failed" attention kind — removed. The needs-
   attention query returns only waiting/blocked/parked tickets:
   `WorkflowReadModel.ts:1452`.)
5. **Sort (total, no timestamps — Sol SHOULD-12):** project index (eligible
   order) → board name (locale, case-insensitive) → `boardId` tiebreak.
6. **Freshness (resolves Sol MUST-4):** invalidate the target project's
   `listBoards` atom via `registry.refresh(...)` in the `onCreated` path (v1
   does the equivalent, `Sidebar.tsx:2836`) and on **re-entering** Workflows
   mode; the attention atom refreshes on mode-enter. (Bounded polling is a
   fast-follow if mode-enter refresh proves insufficient.)

## Workflow row (v2-styled, calm — resolves Grok row-reuse SHOULD)

A **new** `SidebarV2WorkflowRow` (not a reuse of the thread `SidebarV2Row`,
which is thread-shaped — status/unread/model-icon assumptions). Slim-row
anatomy (boards have no active turn):

- `SquareKanbanIcon` + board name; project title muted (list is cross-project).
- **Right status slot:** attention count > 0 → "N need you" with the dominant
  kind's tone (amber approval / indigo input / red blocked / the parked tones
  from sub-states); zero → nothing (calm).
- **`entryError` board:** whole row destructive tone + error glyph + tooltip
  ("this board's file failed to load"); not navigable.
- Click → navigate `/$environmentId/board?boardId=<boardId>` using the shared
  environment-aware board-key + active-route helpers (`Sidebar.logic.ts:38`,
  covered by `Sidebar.logic.test.ts:153`); active board highlighted by the full
  `(environmentId, boardId)` identity, cleared when the route's `boardId` is
  absent or not in the filtered list (Grok MUST).
- **Project-level error row:** a distinct retryable "Couldn't load boards for
  <project>" row (Sol MUST-3), styled subdued, with a retry affordance that
  refreshes that project's atom.
- Read-navigate only; inline rename/delete out of scope v1.
- **Empty state** (all eligible queries succeeded, zero boards): "No workflows
  yet — Add workflow to create one" (mode-specific copy, not "No threads" —
  both reviewers). Shown **only** after every in-scope query succeeds with zero
  (Sol MUST-3), never while any is pending or errored.

## Add-workflow button + create coordinator (resolves Sol MUST-5, SHOULD-8)

The palette **cannot** open a sidebar-owned dialog (it closes before running,
owns its own dialogs, `CommandPalette.tsx:1599,688`; the sidebar is the
replaceable component). So creation is owned by a **stable
`WorkflowCreateCoordinator`** mounted in `AppSidebarLayout` (outside both
sidebar variants). It owns: selected `(projectId, environmentId)`, the
close-palette → open-`CreateWorkflowDialog` sequence, `api` construction for the
primary environment, `existingBoardNames`, `onCreated` invalidation +
navigation.

The Add-workflow button replaces New-thread when `mode === "workflows"`
(`SquareKanbanIcon`, `aria-label="Add workflow"`, preserving the New-thread
button's width to avoid header jitter — Grok NIT). Its handler branches on
**eligible (primary-env, in-scope) project count** (Sol SHOULD-8):

- If project-scope is a specific primary-env project → target it directly
  (open the coordinator's dialog for that project).
- Else (scope = All primary-env projects): **0** eligible → button disabled
  with an explanatory tooltip + empty-state CTA; **1** → open dialog directly;
  **>1** → emit a `new-workflow-in` intent on `commandPaletteBus` carrying the
  chosen project once the user picks from a new palette submenu (a clean mirror
  of `new-thread-in`). The coordinator listens for that intent and opens the
  dialog. This requires extending the bus intent union + the palette submenu +
  the coordinator (all named in Files).

`onCreated(boardId)` → `registry.refresh` the project's `listBoards` +
navigate `/$environmentId/board?boardId=<boardId>` (same as v1).

## Search & deep-link behavior (resolves Grok SHOULDs)

- The **search button** is unchanged in both modes — it opens the command
  palette (global thread/project search). Workflows mode adds **no** separate
  in-list board-name filter box in v1 (fast-follow if wanted). Documented so an
  implementer doesn't invent one.
- **Deep-linking to a board route while in Threads mode leaves the sidebar mode
  unchanged** (the board page is its own route, independent of sidebar mode);
  the workflows-list active-board highlight only appears when the user is in
  Workflows mode. No auto-switch.

## Files (create / modify)

- Modify: `SidebarV2.tsx` (switch row, mode from settings + cleanup, conditional
  list render + New/Add button swap, mode-neutral scope label),
  `AppSidebarLayout.tsx` (mount `WorkflowCreateCoordinator`),
  `CommandPalette.tsx` + `commandPaletteBus.ts` (the `new-workflow-in` intent +
  submenu), `packages/contracts/src/settings.ts` (+ its test + desktop fixture)
  for `sidebarV2Mode`.
- Create: `WorkflowSidebarList.tsx` (mounts in mode; owns the aggregate atom +
  subscription lifecycle), `SidebarV2WorkflowRow.tsx`,
  `useWorkflowSidebarEntries.ts` (the aggregate hook: eligible-filter →
  fan-out → join → sort → error/pending), `workflowSidebarStatus.ts` (pure
  attention→pill mapper incl. the precedence order, unit-tested),
  `WorkflowCreateCoordinator.tsx`.
- Reuse: `CreateWorkflowDialog` (unchanged — primary-env only), `ui/toggle-group`,
  `useProjects`, `Sidebar.logic` board-key + active-route helpers,
  `registry.refresh` invalidation idiom.

## Out of scope (v1)

Cross-environment boards in the sidebar (primary env only); a capability RPC;
inline board rename/delete; recency sort (needs a board-list timestamp / new
RPC); per-board digest counts on rows; in-list board-name search filter;
bounded attention polling; v1 sidebar changes; mobile; drag-reorder.

## Testing

- `workflowSidebarStatus` (pure): dominant-kind precedence
  (blocked>parked_issue>approval>input>parked_waiting>null), count grouping by
  `(environmentId, boardId)`, error tone.
- `useWorkflowSidebarEntries` (mocked atoms): eligible = primary-env ∩ scope;
  fan-out flatten + `(env,project,board)` tagging; **partial-success** (one
  project errors → others still render + `errorsByProject`), pending while any
  loading, empty **only** when all succeed with zero; entry-error vs
  project-error distinction; sort totality incl. tiebreak.
- Switch: persists to/from ClientSettings **only after hydration**; toggling
  swaps list + button and clears thread selection/rename; controlled value
  ignores empty payloads.
- Add-workflow: scoped-project targets directly; All-scope 0 disabled / 1 direct
  / >1 palette submenu; coordinator opens dialog for the emitted project;
  `onCreated` invalidates + navigates.
- Row: name/project/pill; entry-error destructive + non-navigating; project-
  error retry row; active-board highlight by full identity, cleared when boardId
  absent; empty-state copy.
- Coordinator lives outside the sidebar (survives mode/sidebar-variant switches).
- Contracts: `sidebarV2Mode` decode default + partial round-trip; desktop
  fixture parity.
