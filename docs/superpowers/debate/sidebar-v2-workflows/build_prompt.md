You are Grok 4.5 building a feature in the t3code repo (/Users/chris/Developer/t3code) on branch feat/sidebar-v2-workflows (already checked out). Build EXACTLY the approved, twice-reviewed spec below. Edit the repo directly.

APPROVED SPEC (v2, post Grok+Sol review — every MUST folded in): the normative
contract is the file
`docs/superpowers/specs/2026-07-22-sidebar-v2-workflows-mode-design.md`.
READ IT IN FULL with your file tools before writing anything — its "Files" and
"Testing" sections are binding.

BUILD ORDERS:

1. READ the spec file docs/superpowers/specs/2026-07-22-sidebar-v2-workflows-mode-design.md in full — it is normative, including the "Files" and "Testing" sections.
2. FOLLOW EXISTING CONVENTIONS exactly. Before writing each file, read the neighbors: SidebarV2.tsx (row anatomy, header cluster, handleNewThreadClick pattern ~:1437, project-scope menu ~:1513), DiffPanel.tsx:686 (ToggleGroup usage), CommandPalette.tsx + commandPaletteBus.ts (new-thread-in intent + submenu pattern — mirror it for new-workflow-in), CreateWorkflowDialog.tsx (props :64, unchanged), Sidebar.tsx:2732-2846 (v1 create trigger + dialog mount + onCreated navigate/refresh — the coordinator mirrors this), Sidebar.logic.ts:38 (board-key + active-route helpers — REUSE, don't reinvent), packages/contracts/src/settings.ts (how renderHtmlEmbeds was added: full schema + optionalKey partial + test; also DesktopClientSettings.test.ts fixture), useBoardApi.ts / subscribeBoardRaw in useWorkflowApi.ts (the registry.mount+subscribe aggregate-atom idiom for the WorkflowSidebarList's single subscription; and registry.refresh for onCreated invalidation).
3. IMPLEMENT the spec's data model precisely:
   - PRIMARY ENVIRONMENT ONLY (v1 scope). Eligible projects = primary-env projects ∩ current project-scope, filtered BEFORE building atoms.
   - WorkflowSidebarList mounts ONLY in workflows mode; one memoized aggregate atom reads the per-eligible-project listBoards atoms + one listNeedsAttentionTickets atom, subscribed once (NOT useEnvironmentQuery inside .map()).
   - Aggregate state = { boards, pending, errorsByProject }; PARTIAL SUCCESS preserved (a failing project → error row + errorsByProject entry, does NOT blank the list); empty state ONLY when all eligible queries succeed with zero boards.
   - entryError (BoardListEntry.error, a decode failure) = destructive board row; project-level query failure = a separate retryable project-error row. Distinct.
   - Attention join: group listNeedsAttentionTickets by (environmentId, boardId) → count + dominant kind by TOTAL precedence blocked > parked_issue > waiting_for_approval > waiting_for_input > parked_waiting, null when none. NO "failed" kind (it doesn't exist).
   - Sort: eligible project index → board name (locale, case-insensitive) → boardId tiebreak.
   - onCreated + mode-enter → registry.refresh the relevant listBoards; attention refreshes on mode-enter.
4. WorkflowCreateCoordinator mounts in AppSidebarLayout (OUTSIDE both sidebar variants); owns selected (projectId, environmentId), close-palette→open-dialog, api, existingBoardNames, onCreated invalidate+navigate. The palette new-workflow-in submenu emits a bus intent the coordinator consumes.
5. Switch: controlled ToggleGroup value={[mode]}, ignore empty payloads; ordered search → switch → project-scope; mode-neutral scope label. Persist sidebarV2Mode ONLY after useClientSettingsHydrated(). Threads→Workflows clears thread selection + cancels rename.
6. Add-workflow button replaces New-thread in workflows mode (preserve width); handler branches on eligible count per spec (scoped-project direct / All: 0 disabled, 1 direct, >1 palette submenu).
7. TESTS: add/adjust every test the spec's Testing section lists (workflowSidebarStatus pure mapper; useWorkflowSidebarEntries partial-success/pending/empty/error-distinction/sort; switch persist-after-hydration + cleanup + empty-payload-ignore; add-workflow branches + coordinator; row states + active highlight; contracts settings round-trip + desktop fixture). Follow the repo's existing test idioms (web tests are SSR via renderToStaticMarkup / vitest; pure logic in colocated .test.ts; contracts schema round-trips).
8. DO NOT touch unrelated code. DO NOT change v1 Sidebar.tsx behavior, the board engine, or park-in-place code. DO NOT push. DO NOT commit (the orchestrator commits after review).
9. BEFORE FINISHING: run scoped typecheck (npx tsgo --noEmit in packages/contracts, apps/web; npx tsc --noEmit in apps/desktop if you touched the fixture) and the touched test files (cd apps/web && npx vitest run <files>; cd packages/contracts && npx vitest run src/settings.test.ts). Report exact results. If a check is red, fix it before finishing.

HARD RULES: no `any`, no type casts (repo policy — the ONE documented cast is not needed here); match the repo's effect/atom + Base-UI idioms; keep rows calm (color signals, not noise). Report: files created/modified, the aggregate-atom subscription mechanism you used, how the coordinator receives the palette intent, and per-package typecheck + test results.
