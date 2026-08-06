No MUST, SHOULD, or NIT findings.

- Render-phase reset is conditional, converges after one rerender, and is StrictMode-safe. The identity guard prevents stale rows on the pre-reset render; old subscription writes remain keyed and cannot surface across scopes ([useWorkflowSidebarEntries.ts](/Users/chris/Developer/t3code/apps/web/src/workflow/useWorkflowSidebarEntries.ts:224), [hook state](/Users/chris/Developer/t3code/apps/web/src/workflow/useWorkflowSidebarEntries.ts:338), [subscription](/Users/chris/Developer/t3code/apps/web/src/workflow/useWorkflowSidebarEntries.ts:349)).
- `boardsSettled` correctly handles loading, failure, cached/SWR data, and the idle null-atom path ([WorkflowCreateCoordinator.tsx](/Users/chris/Developer/t3code/apps/web/src/components/WorkflowCreateCoordinator.tsx:125), [query.ts](/Users/chris/Developer/t3code/apps/web/src/state/query.ts:24)).
- Tests invoke the exported production listener through the real bus and call the real component-created dialog callbacks ([WorkflowCreateCoordinator.test.tsx](/Users/chris/Developer/t3code/apps/web/src/components/WorkflowCreateCoordinator.test.tsx:213), [callback tests](/Users/chris/Developer/t3code/apps/web/src/components/WorkflowCreateCoordinator.test.tsx:307)).
- Verification passed: `npx tsgo --noEmit`; 7 feature test files, 59/59 tests.

PASS
