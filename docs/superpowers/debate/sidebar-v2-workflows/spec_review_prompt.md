You are an adversarial design reviewer for the t3code repo (/Users/chris/Developer/t3code, branch feat/sidebar-v2-workflows). Review the design spec at:

docs/superpowers/specs/2026-07-22-sidebar-v2-workflows-mode-design.md

Feature: add a Threads/Workflows switch to Sidebar v2 (the new flat threads-only sidebar from upstream #4026). In Workflows mode the sidebar shows a flat, v2-styled list of workflow boards across projects, and the New-thread button becomes an Add-workflow button with project selection.

Ground yourself in the ACTUAL code before judging — the spec cites file:line refs; spot-check the load-bearing ones:

- apps/web/src/components/SidebarV2.tsx (header/search row ~:1463-1512, project-scope menu row ~:1513-1593, row component SidebarV2Row ~:239, partition ~:880, handleNewThreadClick ~:1437-1451)
- apps/web/src/components/AppSidebarLayout.tsx (~:103,108,180 — v1/v2 selection)
- packages/contracts/src/workflow.ts (BoardListEntry ~:1064 — minimal; WorkflowNeedsAttentionTicketView ~:961 carries boardId+boardName; TicketStatus/WorkflowTicketAttentionKind)
- packages/contracts/src/ipc.ts (listBoards ~:1328 per-project; listNeedsAttentionTickets env-global; getBoardDigest ~:1428)
- apps/web/src/components/board/CreateWorkflowDialog.tsx (props ~:64 take projectId+environmentId, no project selector)
- packages/contracts/src/settings.ts (ClientSettings — how sidebar prefs / renderHtmlEmbeds are defined, decode defaults, the optionalKey partial)
- apps/web/src/components/ui/toggle-group.tsx + DiffPanel.tsx:686 (segmented control precedent)
- apps/web/src/state/entities.ts (~:105 useProjects) — and the v1 board-capability gating (Sidebar.tsx boardMember / memberProjects) the spec says to reuse.

Attack dimensions:

1. Feasibility of load-bearing claims: does the cited code actually support the design? (Can ClientSettings grow sidebarV2Mode the same way renderHtmlEmbeds was added? Is listNeedsAttentionTickets truly env-global with per-row boardId? Does CreateWorkflowDialog work unchanged when driven from a project-picked context? Is the board-capability predicate actually reusable/extractable?)
2. Client fan-out data model: N projects × listBoards atoms + one listNeedsAttentionTickets per environment — subscription/atom lifecycle, staleness, sort stability with no timestamps, multi-environment correctness (projects span environments — does the flat list correctly key by environmentId+boardId, and does listNeedsAttentionTickets need calling per-environment not once?).
3. The switch + project-scope interaction: the project-scope menu applies to both modes — any conflict, and does the switch row placement break v2's existing layout/settled-divider logic?
4. Add-workflow palette submenu: is new-workflow-in a clean mirror of new-thread-in, and does the ≤1-project-direct vs multi-project-palette branch match how New-thread actually behaves?
5. Missing edge cases: boards with load errors, projects that don't support boards, zero-board empty state, active-board highlight correctness across the boardId search param, mode persistence race with settings load.
6. Scope: right-sized for one plan? anything that should move in/out?

HARD RULES: READ ONLY (no file modifications, no builds; scoped reads only). No style nits. Classify every finding MUST / SHOULD / NIT with file:line evidence and a concrete recommendation. End with a one-line verdict: SHIP AS-IS / SHIP WITH FIXES / RETHINK.
