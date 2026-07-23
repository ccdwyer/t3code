# Adversarial Design Review: Sidebar v2 Workflows Mode

**Spec:** `docs/superpowers/specs/2026-07-22-sidebar-v2-workflows-mode-design.md`  
**Feature:** Threads/Workflows switch on Sidebar v2; flat cross-project board list; New-thread → Add-workflow with project pick  
**Constraint:** Review grounded only in the prompt’s claims and cited surfaces (no live file reads).

---

## 1. Feasibility of load-bearing claims

### MUST — Multi-environment `listNeedsAttentionTickets` is under-specified

**Claim (prompt):** `listNeedsAttentionTickets` is “env-global”; `WorkflowNeedsAttentionTicketView` carries `boardId` + `boardName` (~961); `listBoards` is per-project (~1328).
**Attack:** A flat list “across projects” is only correct if attention is fetched **once per environment that has in-scope projects**, not once globally. Projects span environments. If the design assumes a single `listNeedsAttentionTickets` call for the whole client, boards in secondary environments will show zero attention badges while still appearing from per-project `listBoards`. Conversely, if attention is env-scoped but board rows are keyed only by `boardId`, collisions across environments are possible.
**Evidence from prompt:** contracts split is explicit (`listBoards` per-project vs attention env-global; digests at ~1428).
**Recommendation:** Spec must require: (a) derive the set of distinct `environmentId`s from in-scope projects; (b) call `listNeedsAttentionTickets` **per environment**; (c) key every sidebar row and attention merge as `(environmentId, boardId)` (and preferably surface `boardName` only as display, not identity). Document the merge of attention maps into board rows with that composite key.

---

### MUST — Composite identity for flat list vs URL `boardId`

**Claim:** Active-board highlight uses `boardId` search param.
**Attack:** If navigation/highlight is `?boardId=…` alone, two boards with the same id in different environments (or remount/recreate edge cases) will double-highlight or highlight the wrong row. Prompt already flags “active-board highlight correctness across the boardId search param” as an edge case — this is not optional polish; it is identity correctness for a multi-project, multi-env flat list.
**Recommendation:** Confirm whether board IDs are globally unique in the product. If not (or if not guaranteed), the design must extend route/query identity to include `environmentId` (and/or `projectId`) and match highlight on the full key. If IDs _are_ guaranteed unique, state that invariant in the spec so implementers don’t invent partial keys.

---

### SHOULD — `ClientSettings.sidebarV2Mode` “same as `renderHtmlEmbeds`” is plausible but incomplete

**Claim:** Extend `ClientSettings` like `renderHtmlEmbeds` (optionalKey partial, decode defaults) in `packages/contracts/src/settings.ts`.
**Attack:** Mode is not a pure boolean cosmetic flag: it changes primary chrome (list content + primary CTA). Risks the design under-weights:

1. **Decode default** — default must be threads (or last known) so first paint before settings hydrate doesn’t flash Workflows chrome.
2. **Persistence race** — settings load vs first render (called out in edge cases): if mode is written optimistically and decode fails / older clients strip unknown keys, you get mode flip-flop.
3. **v1 coexistence** — `AppSidebarLayout` selects v1/v2 (~103,108,180). Does `sidebarV2Mode` apply only when v2 is active, or can a persisted Workflows mode surprise a user who switches back to v1 and forth again?
   **Recommendation:** Spec should mandate: default `"threads"`; ignore/persist only under Sidebar v2; no server migration; optimistic UI with last-known local value if you already have a client settings cache pattern; document that unknown keys remain optionalKey so older peers don’t reject settings blobs.

---

### SHOULD — `CreateWorkflowDialog` “unchanged” is only true if parent always supplies valid board-capable context

**Claim:** Props ~:64 take `projectId` + `environmentId`, no project selector — driven from a project-picked context.
**Attack:** Dialog works unchanged **only if** the Add-workflow path never opens it with a project that fails board capability / lacks environment. Palette can pick any project in “member projects” unless the list is filtered. Spec says reuse v1 `boardMember` / `memberProjects` gating — if palette filters correctly, OK; if it only mirrors `new-thread-in` project list, boards may open create on non-board projects.
**Recommendation:** Explicit pre-filter: palette and ≤1-project direct path only offer projects that pass the same board-capability predicate as v1. On open, assert `projectId`+`environmentId` both set; if env missing, don’t open dialog — show toast / disable row.

---

### SHOULD — Board-capability predicate “extractable from Sidebar.tsx” is a hidden dependency

**Claim:** Reuse v1 board-capability gating (`Sidebar.tsx` boardMember / memberProjects).
**Attack:** Extracting a predicate used only in v1 into a shared helper is the right shape, but if that logic is inline (membership + feature flag + env capability mixed), “reuse” becomes copy-paste or a half-extraction that diverges. Flat Workflows mode needs that gate for: project scope menu (show only board-capable projects?), palette entries, and empty-state copy.
**Recommendation:** Plan step 0: extract pure `projectSupportsBoards(project | member)` (or whatever the real inputs are) with unit-testable inputs; both v1 Sidebar and SidebarV2 import it. Spec should name the exact condition, not only “reuse v1.”

---

### NIT — Segmented control precedent (`toggle-group` + DiffPanel ~686)

## Using existing toggle-group for Threads/Workflows is sound. DiffPanel is a different density context; visual parity with DiffPanel is not required — only a11y role and keyboard behavior. Not a design blocker.

## 2. Client fan-out data model

### MUST — Subscription / atom lifecycle for N × `listBoards`

**Claim:** N projects × `listBoards` atoms + attention per environment.
**Attack:**

- **Mount cost:** Every project in scope (or every member project) gets a live subscription. Expanding project scope or logging into large orgs multiplies IPC + re-renders.
- **Unmount / scope change:** When project-scope menu narrows to one project, do other boards’ atoms unsubscribe? If not, memory and churn grow forever for the session.
- **Staleness:** Flat list with no board timestamps (prompt: “sort stability with no timestamps”) means client-defined sort only. Attention tickets may update without board list reordering — OK if sort is name/stable id; bad if sort is “recent activity” without a field.
  **Recommendation:** Spec must define:

1. **Which projects are subscribed:** intersection of (scope filter) ∩ (board-capable) ∩ (loaded projects from `useProjects` ~105).
2. **Teardown:** atoms/subscriptions drop when a project leaves scope or mode leaves Workflows (or keep warm — pick one; warm is costlier).
3. **Sort key:** e.g. `boardName` localeCompare, then `boardId`, then `environmentId` — deterministic, no fake “recency.”
4. **Attention overlay:** recompute badge counts by composite key without resorting unless count-based sort is explicitly desired (probably not).

---

### MUST — Attention is not a drop-in for board rows without a join strategy

Attention view has `boardId`+`boardName` but may reference boards not yet returned by `listBoards` (deleted, permission race) or boards outside project scope.
**Recommendation:** Join policy: **boards list is source of truth for rows**; attention only annotates. Orphan attention (boardId not in list) is dropped or shown only if product wants “ghost” boards — default drop. Scope filter applies to boards first, then annotate.

---

### SHOULD — `getBoardDigest` (~1428) role is unclear in a “flat list”

If digests are for richer row subtitles (open tickets, last activity), N boards × digest is a second fan-out on top of `listBoards`. If digests are out of scope for v1 of this feature, say so; if in scope, lazy-load visible rows only.
**Recommendation:** For one-plan size: **no digests in row UI** unless already cheap via list payload. Prefer counts derived from `listNeedsAttentionTickets` aggregation per board.

---

## 3. Switch + project-scope interaction

### MUST — Project-scope menu “applies to both modes” needs semantic definition

**Attack:** In Threads mode, scope likely filters **threads by project**. In Workflows mode, the same control should filter **boards by project**. Ambiguities:

- Scope = “All projects” vs single project: clear.
- Scope = multi-select / custom subsets: does Workflows honor the same subset?
- Empty after filter: threads empty state vs boards empty state — different CTAs (New thread vs Add workflow).
  If scope state is shared and user filters to a project with threads but no boards (or vice versa), switching modes looks “broken.”
  **Recommendation:** Spec should state: one shared `projectScope` state; each mode applies it to its entity type; empty states are mode-specific; optional: when switching to Workflows, do not auto-reset scope.

---

### SHOULD — Switch placement vs header/search (~1463–1512) and project-scope row (~1513–1593)

**Attack:** Inserting a Threads | Workflows control into the header/search row can:

- Compress search width (v2 search is primary find UX).
- Interact with “settled divider” logic around partition (~880) if the switch is treated as a sticky region vs content.
- Sit adjacent to New-thread / Add-workflow (~1437–1451) and cause dual primary CTAs visual noise.
  **Recommendation:** Prefer a dedicated full-width control **below** search and **above** project-scope (or as a slim segmented row), not inside the search field cluster. Confirm settled-divider still keys off thread list scroll regions, not the switch. Document that Workflows mode **hides** thread partition UI (pinned/recent/etc. if any) entirely — one list primitive only.

---

## 4. Add-workflow palette vs New-thread

### SHOULD — “≤1 project direct / multi-project palette” must match real New-thread behavior

**Claim:** Mirror `new-thread-in`; branch on project count.
**Attack:** Prompt cites `handleNewThreadClick` ~1437–1451. Without the body, risks include:

- New-thread may use **scoped** projects vs **all member** projects — Add-workflow must use the same set **after board-capability filter**, which can turn “2 projects” into “1 board-capable project” and should then take the **direct** path.
- Direct path with 0 board-capable projects: button should disable or explain, not open empty palette / broken dialog.
- Submenu id `new-workflow-in` vs `new-thread-in`: ensure command palette registration doesn’t collide and that keyboard shortcuts don’t fire create-thread while in Workflows mode.
  **Recommendation:** Spec algorithm:

```
eligible = boardCapable(projectsInScope)
if eligible.length === 0 → disable Add-workflow + empty state CTA to docs/settings
if eligible.length === 1 → open CreateWorkflowDialog(projectId, environmentId)
else → palette submenu new-workflow-in listing eligible only
```

## Mirror New-thread’s scope source of truth exactly, then filter.

### NIT — Button label/icon swap on mode change should preserve layout width to avoid header jitter (implementation detail, not design rethink).

---

## 5. Missing edge cases

| Edge case                                | Severity   | Recommendation                                                                                                                        |
| ---------------------------------------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| Board `listBoards` error for one project | **MUST**   | Per-project error row or silent omit + single “Some projects failed to load boards” banner; do not fail entire Workflows mode         |
| Project doesn’t support boards           | **MUST**   | Exclude from palette, subscriptions, and scope counts for boards; don’t show empty forever                                            |
| Zero boards empty state                  | **SHOULD** | Distinct copy + Add-workflow CTA; not “No threads”                                                                                    |
| Active board highlight                   | **MUST**   | Full identity key; clear highlight when `boardId` missing or not in filtered list                                                     |
| Mode persistence race                    | **SHOULD** | Default threads until settings resolved; avoid writing mode until hydrate complete                                                    |
| Search in Workflows mode                 | **SHOULD** | Spec must say whether search filters boards by name only, and that it does not search threads while in Workflows                      |
| Deep link to board while in Threads mode | **SHOULD** | Opening a board route should auto-switch to Workflows **or** leave mode alone and only highlight if mode matches — pick one, document |
| `SidebarV2Row` (~239) reuse              | **SHOULD** | Confirm row props can show board name + attention badge without thread-only assumptions (status, unread, model icons)                 |

---

## 6. Scope right-sizing

### In-scope (appropriate for one plan)

- Mode switch + persistence key
- Flat board list for scoped, board-capable projects
- Attention badge via needs-attention join
- CTA swap + project pick + existing `CreateWorkflowDialog`
- Shared project scope
- Empty / error basics

### SHOULD leave out of this plan

- Board digests / activity sort
- Hierarchical project → boards nesting (v2 is flat by design)
- Creating boards from non-capable projects
- Cross-environment board search parity with full command palette
- Migrating v1 Sidebar boards UX into v2 beyond the flat list
- Drag-reorder boards

### SHOULD pull in if missing from spec

- Explicit composite keys and per-environment attention fetch
- Extracted board-capability helper
- Search behavior in Workflows mode
- Subscription teardown rules
- Deep-link / mode interaction  
  One plan is feasible **if** digests and v1 feature parity are out and identity/attention/env rules are written down. As described, the data model is the main risk of scope blow-up during implementation.

---

## Cross-cutting findings (classified)

1. **MUST** — Per-environment attention fetch + `(environmentId, boardId)` row identity; single global attention call is incorrect for multi-env.
2. **MUST** — Active highlight and routing identity match that composite key (or document global uniqueness of `boardId`).
3. **MUST** — Join policy: boards own rows; attention annotates; per-project load errors don’t blank the mode.
4. **MUST** — Board-capability filter on palette, direct-create, and subscriptions; don’t reuse raw New-thread project lists.
5. **SHOULD** — Shared project scope semantics + mode-specific empty states; no silent “empty” when scope has threads but no boards.
6. **SHOULD** — Sort stability without timestamps; no digest fan-out in v1 of feature.
7. **SHOULD** — Settings default + hydrate race; mode only meaningful under Sidebar v2 (`AppSidebarLayout` selection).
8. **SHOULD** — Switch placement outside search cluster; hide thread partition UI in Workflows mode.
9. **SHOULD** — Eligible-count branch after capability filter (0 / 1 / many), not raw project count.
10. **NIT** — Toggle-group precedent is fine; don’t overfit DiffPanel styling.

---

## Verdict

**SHIP WITH FIXES** — The product shape (mode switch, flat boards, CTA → existing dialog, shared scope) fits Sidebar v2 and the cited APIs, but the design is not safe to implement until multi-environment attention, composite board identity, capability-filtered project pick, subscription lifecycle, and join/error policy are specified; without those, the flat list will ship wrong badges, wrong highlights, or unbounded fan-out.
