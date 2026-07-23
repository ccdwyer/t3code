The concept is feasible, but the spec is not implementation-ready. The settings and routing claims hold; the capability gate, fan-out lifecycle, freshness, palette handoff, and multi-environment creation claims do not.

## MUST findings

1. **MUST — The claimed board-capability predicate does not exist, and the zero-project branch is invalid.**

Evidence: `useProjects()` returns every environment project without workflow metadata ([entities.ts](/Users/chris/Developer/t3code/apps/web/src/state/entities.ts:105)); neither projects nor environment capabilities expose workflow support ([orchestration.ts](/Users/chris/Developer/t3code/packages/contracts/src/orchestration.ts:382), [environment.ts](/Users/chris/Developer/t3code/packages/contracts/src/environment.ts:40)). V1’s `boardMember` is merely `memberProjects[0]`, not a capability check ([Sidebar.tsx](/Users/chris/Developer/t3code/apps/web/src/components/Sidebar.tsx:1555)). The spec’s `≤1` rule also dereferences “that project” when the count is zero ([design spec](/Users/chris/Developer/t3code/docs/superpowers/specs/2026-07-22-sidebar-v2-workflows-mode-design.md:97)).

Recommendation: either add an explicit environment workflow capability—expanding beyond “no server changes”—or remove the capability claim and treat unsupported RPC failures as availability errors. Define exact `0 / 1 / >1` behavior: disable with explanation, direct-open, palette.

2. **MUST — `useWorkflowSidebarEntries` needs a legal dynamic-subscription architecture.**

Evidence: `useEnvironmentQuery` subscribes to exactly one atom through React hooks ([query.ts](/Users/chris/Developer/t3code/apps/web/src/state/query.ts:24)); the number of projects and environments is dynamic. Calling it inside `projects.map()` would violate hook ordering. Family atoms also remain idle-cached for five minutes, not five seconds ([runtime.ts](/Users/chris/Developer/t3code/packages/client-runtime/src/state/runtime.ts:475)).

Recommendation: mount a dedicated `WorkflowSidebarList` only in Workflows mode. Inside it, build one memoized aggregate atom that dynamically reads the canonical `listBoards` atoms and one attention atom per distinct environment, then subscribe once. Key dependencies by stable `environmentId:projectId`.

3. **MUST — Query failures would be misreported as “No workflows yet.”**

Evidence: `BoardListEntry.error` represents a successfully discovered board file that failed to decode/load ([workflow.ts](/Users/chris/Developer/t3code/packages/contracts/src/workflow.ts:1064), [BoardDiscovery.ts](/Users/chris/Developer/t3code/apps/server/src/workflow/Layers/BoardDiscovery.ts:126)). Whole `listBoards` failures instead appear as `data: null` plus a query-level error ([query.ts](/Users/chris/Developer/t3code/apps/web/src/state/query.ts:24)). The spec only handles entry errors and zero entries.

Recommendation: return aggregate pending state and `errorsByScopedProject`, preserve partial successes, render retryable project/environment errors, and show the empty state only after every in-scope query succeeds with zero boards.

4. **MUST — The list and attention pills can remain stale indefinitely.**

Evidence: `listBoards` has a five-second stale window, not polling; `listNeedsAttentionTickets` has no refresh interval ([workflow.ts](/Users/chris/Developer/t3code/packages/client-runtime/src/state/workflow.ts:66), [workflow.ts](/Users/chris/Developer/t3code/packages/client-runtime/src/state/workflow.ts:111)). The runtime revalidates on mount and only polls when `refreshIntervalMs` is configured ([runtime.ts](/Users/chris/Developer/t3code/packages/client-runtime/src/state/runtime.ts:489)). V1 explicitly refreshes boards after creation ([Sidebar.tsx](/Users/chris/Developer/t3code/apps/web/src/components/Sidebar.tsx:2836)).

Recommendation: invalidate the selected project’s board query in every `onCreated` path, refresh on re-entering Workflows mode, and define bounded polling or event-driven invalidation for each environment’s attention query. Test changes while Workflows mode remains mounted.

5. **MUST — `new-workflow-in` cannot simply open a Sidebar-owned dialog.**

Evidence: existing palette project items perform thread creation directly inside `CommandPalette` ([CommandPalette.tsx](/Users/chris/Developer/t3code/apps/web/src/components/CommandPalette.tsx:688)). The event bus and reducer have closed intent unions and no selected-project result channel ([commandPaletteBus.ts](/Users/chris/Developer/t3code/apps/web/src/commandPaletteBus.ts:5), [CommandPalette.tsx](/Users/chris/Developer/t3code/apps/web/src/components/CommandPalette.tsx:338)). V1 locally owns its dialog ([Sidebar.tsx](/Users/chris/Developer/t3code/apps/web/src/components/Sidebar.tsx:2826)). Palette actions close the palette before running ([CommandPalette.tsx](/Users/chris/Developer/t3code/apps/web/src/components/CommandPalette.tsx:1599)).

Recommendation: specify a stable workflow-create coordinator outside the replaceable sidebar. It must own the selected project, close palette → open dialog sequencing, API construction, existing names, invalidation, and navigation. Add `CommandPalette.tsx`, `commandPaletteBus.ts`, and/or the coordinator to the file list; the cited “actions module” does not currently exist.

6. **MUST — `CreateWorkflowDialog` is not safe unchanged for arbitrary environments.**

Evidence: the dialog receives a selected environment/project/API ([CreateWorkflowDialog.tsx](/Users/chris/Developer/t3code/apps/web/src/components/board/CreateWorkflowDialog.tsx:64)), but its agent choices and settings come from the primary environment ([CreateWorkflowDialog.tsx](/Users/chris/Developer/t3code/apps/web/src/components/board/CreateWorkflowDialog.tsx:165)). Meanwhile, mutations correctly target the API’s selected environment ([useWorkflowApi.ts](/Users/chris/Developer/t3code/apps/web/src/workflow/useWorkflowApi.ts:29)). A remote project can therefore be offered primary-only provider/model identifiers.

Recommendation: type the prop as `EnvironmentId` and source providers plus server settings from that environment, or explicitly restrict creation to the primary environment. Add a remote-environment test with differing provider inventories.

7. **MUST — “Dominant attention kind” is not defined and the failed-state claim is false.**

Evidence: attention kind is nullable and contains approval, input, blocked, and two parked kinds—no failed kind ([workflow.ts](/Users/chris/Developer/t3code/packages/contracts/src/workflow.ts:507), [workflow.ts](/Users/chris/Developer/t3code/packages/contracts/src/workflow.ts:961)). The server query only returns waiting, blocked, and parked tickets, excluding failed tickets ([WorkflowReadModel.ts](/Users/chris/Developer/t3code/apps/server/src/workflow/Layers/WorkflowReadModel.ts:1452)). The spec promises precedence tests without specifying precedence.

Recommendation: define a total deterministic order and null fallback, for example `blocked > parked_issue > approval > input > parked_waiting > null`. Remove “failed” unless it only names a shared color token.

## SHOULD findings

8. **SHOULD — Project scope and Add-workflow targeting conflict.**

Evidence: scope identifies one exact environment/project and filters the visible list ([SidebarV2.tsx](/Users/chris/Developer/t3code/apps/web/src/components/SidebarV2.tsx:849), [SidebarV2.tsx](/Users/chris/Developer/t3code/apps/web/src/components/SidebarV2.tsx:880)). The proposed Add action instead branches on the global eligible-project count ([design spec](/Users/chris/Developer/t3code/docs/superpowers/specs/2026-07-22-sidebar-v2-workflows-mode-design.md:94)).

Recommendation: a capable scoped project should be targeted directly; an incapable scope should show an explicit unsupported state; only “All projects” should use the global picker.

9. **SHOULD — Mode switching needs hidden thread-state cleanup.**

Evidence: Sidebar v2 already clears selection when a scope change hides rows because hidden rows must not remain actionable ([SidebarV2.tsx](/Users/chris/Developer/t3code/apps/web/src/components/SidebarV2.tsx:869)). Selection is external state, and rename state remains in the mounted component ([SidebarV2.tsx](/Users/chris/Developer/t3code/apps/web/src/components/SidebarV2.tsx:1027)).

Recommendation: Threads → Workflows should clear thread selection and cancel rename. Add this to the switch test.

10. **SHOULD — The switch contract is internally inconsistent and must preserve a non-empty selection.**

Evidence: motivation says “above search,” while the detailed section says below search ([design spec](/Users/chris/Developer/t3code/docs/superpowers/specs/2026-07-22-sidebar-v2-workflows-mode-design.md:12), [design spec](/Users/chris/Developer/t3code/docs/superpowers/specs/2026-07-22-sidebar-v2-workflows-mode-design.md:39)). `ToggleGroup` uses array-valued toggle semantics ([toggle-group.tsx](/Users/chris/Developer/t3code/apps/web/src/components/ui/toggle-group.tsx:17)); the existing precedent guards empty values ([DiffPanel.tsx](/Users/chris/Developer/t3code/apps/web/src/components/DiffPanel.tsx:686)). The project filter is also hard-coded as “Filter threads by project” ([SidebarV2.tsx](/Users/chris/Developer/t3code/apps/web/src/components/SidebarV2.tsx:1517)).

Recommendation: make search → switch → project scope authoritative; use controlled `value={[mode]}` and ignore empty/invalid changes; make filter labeling mode-neutral.

11. **SHOULD — Apply scope before fan-out and bound concurrency.**

Evidence: the spec filters only after querying every project. Each `listBoards` call invokes discovery ([WorkflowRpcHandlers.ts](/Users/chris/Developer/t3code/apps/server/src/workflow/Layers/WorkflowRpcHandlers.ts:2697)), which scans, reads, decodes, and registers board files ([BoardDiscovery.ts](/Users/chris/Developer/t3code/apps/server/src/workflow/Layers/BoardDiscovery.ts:178)).

Recommendation: filter projects before constructing atoms, query only environments represented in the filtered set, and define bounded concurrency for “All projects.”

12. **SHOULD — Make cross-environment identity and sorting total invariants.**

Evidence: attention rows lack environment/project identity ([workflow.ts](/Users/chris/Developer/t3code/packages/contracts/src/workflow.ts:961)); the existing sidebar already provides environment-aware board keys and active-route matching with collision tests ([Sidebar.logic.ts](/Users/chris/Developer/t3code/apps/web/src/components/Sidebar.logic.ts:38), [Sidebar.logic.test.ts](/Users/chris/Developer/t3code/apps/web/src/components/Sidebar.logic.test.ts:153)). The proposed sort has no tie-breaker.

Recommendation: reuse those helpers, key attention maps by `environmentId:boardId`, and sort by project index → case policy → board name → scoped board identity.

13. **SHOULD — Explicitly close the settings-hydration race.**

Evidence: client settings expose defaults while hydrating asynchronously, then replace the snapshot with persisted data ([useSettings.ts](/Users/chris/Developer/t3code/apps/web/src/hooks/useSettings.ts:91)); updates merge into the current pre-hydration snapshot ([useSettings.ts](/Users/chris/Developer/t3code/apps/web/src/hooks/useSettings.ts:282)). The common persisted-v2 path is partially protected because v2 defaults off and mounts only after that setting hydrates ([settings.ts](/Users/chris/Developer/t3code/packages/contracts/src/settings.ts:105), [AppSidebarLayout.tsx](/Users/chris/Developer/t3code/apps/web/src/components/AppSidebarLayout.tsx:103)), but a rapid same-session enable/navigation path can still race.

Recommendation: disable mode persistence until `useClientSettingsHydrated()` is true or reconcile writes made after hydration begins; add a delayed-hydration test.

## Confirmed claims

- Adding `sidebarV2Mode` to the full schema, `ClientSettingsPatch`, contract tests, and desktop fixture is supported by the existing pattern ([settings.ts](/Users/chris/Developer/t3code/packages/contracts/src/settings.ts:52), [settings.ts](/Users/chris/Developer/t3code/packages/contracts/src/settings.ts:559), [DesktopClientSettings.test.ts](/Users/chris/Developer/t3code/apps/desktop/src/settings/DesktopClientSettings.test.ts:15)).
- Needs-attention is genuinely environment-global, so it must be called once per distinct environment, not once application-wide.
- Active-board highlighting is feasible with the existing environment-plus-board route helper.
- The settled divider is contained inside the thread list; separate keyed thread/workflow list branches will not disturb it.
- This can remain one implementation plan, but the listed file scope is materially understated. If scope must stay narrow, move attention pills and their refresh policy to a fast-follow.

No NIT findings.

SHIP WITH FIXES
