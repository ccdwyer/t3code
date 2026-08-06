## Findings

1. **MUST — stale cross-scope rows remain possible.** The initial sentinel is correct, but the reset occurs in a passive `useEffect` at [useWorkflowSidebarEntries.ts:328](/Users/chris/Developer/t3code/apps/web/src/workflow/useWorkflowSidebarEntries.ts:328). When `aggregateAtom` changes, React first renders using the previous `snapshot` from [line 325](/Users/chris/Developer/t3code/apps/web/src/workflow/useWorkflowSidebarEntries.ts:325), so old rows can commit before the effect resets them. The new tests cover SSR initialization and registry aggregation, but not rerendering the hook with a different aggregate identity.

2. **SHOULD — boards-query deferral does not work in production.** `useEnvironmentQuery` exposes `data: A | null` and converts missing values to `null` at [query.ts:10](/Users/chris/Developer/t3code/apps/web/src/state/query.ts:10) and [query.ts:31](/Users/chris/Developer/t3code/apps/web/src/state/query.ts:31). The coordinator checks `boards === undefined` at [WorkflowCreateCoordinator.tsx:138](/Users/chris/Developer/t3code/apps/web/src/components/WorkflowCreateCoordinator.tsx:138), which the real hook never returns. Consequently [line 114](/Users/chris/Developer/t3code/apps/web/src/components/WorkflowCreateCoordinator.tsx:114) immediately supplies `[]`, preserving the default-name race.

3. **MUST — coordinator tests still bypass the load-bearing production lifecycle.** The test replaces React state to inject a target at [WorkflowCreateCoordinator.test.tsx:31](/Users/chris/Developer/t3code/apps/web/src/components/WorkflowCreateCoordinator.test.tsx:31), mocks the query with the impossible `undefined` state at [line 59](/Users/chris/Developer/t3code/apps/web/src/components/WorkflowCreateCoordinator.test.tsx:59), and replaces the dialog without exposing `onOpenChange` or `onCreated` at [line 74](/Users/chris/Developer/t3code/apps/web/src/components/WorkflowCreateCoordinator.test.tsx:74). The real bus is tested separately, so nothing proves bus → coordinator opening, closing, or `onCreated` refresh/navigation.

The remaining fixes are correctly present: waiting overlays clear correctly, the DI call site uses the canonical production atoms, unknown/non-primary targets are rejected, project titles participate in the aggregate key, and the sentinel shape matches list consumers.

Verification: `npx tsgo --noEmit` passed; 3 focused files and 31/31 tests passed. No files modified.

FAIL
