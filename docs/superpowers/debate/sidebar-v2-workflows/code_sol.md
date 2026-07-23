## Verdict: FAIL

The overall architecture is close, but two load-bearing aggregate-state bugs violate the partial-success/pending/empty contract, and the tests do not exercise that lifecycle.

### MUST findings

1. **False empty state and stale cross-scope rows**

   [useWorkflowSidebarEntries.ts:196](/Users/chris/Developer/t3code/apps/web/src/workflow/useWorkflowSidebarEntries.ts:196) initializes `isEmpty: true`, while the aggregate subscription starts in a passive effect at [line 270](/Users/chris/Developer/t3code/apps/web/src/workflow/useWorkflowSidebarEntries.ts:270). The first Workflows paint therefore shows “No workflows yet” before any query succeeds. When scope or primary environment changes, the previous aggregate snapshot can also render briefly.

   **Fix:** bridge the current aggregate through `useSyncExternalStore` or key snapshots to their aggregate atom and render a pending sentinel until that atom’s immediate value arrives.

2. **SWR refreshes incorrectly report `pending: false`**

   [useWorkflowSidebarEntries.ts:184](/Users/chris/Developer/t3code/apps/web/src/workflow/useWorkflowSidebarEntries.ts:184) classifies `Success` before checking `result.waiting`. In Effect, waiting is an overlay: `Success(waiting=true)` is normal during revalidation. Attention success has the same issue at [line 244](/Users/chris/Developer/t3code/apps/web/src/workflow/useWorkflowSidebarEntries.ts:244).

   Thus mode-enter and retry refreshes can be actively loading while aggregate `pending` remains false.

   **Fix:** OR every raw result’s `.waiting` into aggregate pending independently of its success/failure tag. Add coverage for success-with-waiting and failure-with-waiting.

3. **Load-bearing tests bypass production wiring**

   [WorkflowCreateCoordinator.test.ts:10](/Users/chris/Developer/t3code/apps/web/src/components/WorkflowCreateCoordinator.test.ts:10) defines a test-only acceptance function that production does not use. [WorkflowSidebarList.empty.test.tsx:9](/Users/chris/Developer/t3code/apps/web/src/components/WorkflowSidebarList.empty.test.tsx:9) tests a duplicate component. Aggregate tests only call the pure reducer, so they cannot detect findings 1–2, subscription teardown, or refresh behavior.

   Mode tests verify the production helper, but not actual persistence, selection/rename cleanup, or rendered swapping. Nothing tests coordinator placement, bus delivery, dialog opening, invalidation, or navigation.

   **Fix:** add registry/router-backed component tests using the real hook/list/coordinator and `AppSidebarLayout`.

### SHOULD findings

- **Unknown projects are accepted.** [WorkflowCreateCoordinator.tsx:50](/Users/chris/Developer/t3code/apps/web/src/components/WorkflowCreateCoordinator.tsx:50) searches for the project but opens with `"Project"` even when none matches. Add `if (!project) return`, then construct the target from the matched project.

- **Existing-name loading races dialog initialization.** [WorkflowCreateCoordinator.tsx:80](/Users/chris/Developer/t3code/apps/web/src/components/WorkflowCreateCoordinator.tsx:80) renders immediately with `existingBoardNames=[]`. The dialog seeds its name at [CreateWorkflowDialog.tsx:186](/Users/chris/Developer/t3code/apps/web/src/components/board/CreateWorkflowDialog.tsx:186) and preserves it when real names arrive, potentially suggesting an already-used default. Defer initial seeding until the board query settles.

- **Project titles become stale.** [useWorkflowSidebarEntries.ts:218](/Users/chris/Developer/t3code/apps/web/src/workflow/useWorkflowSidebarEntries.ts:218) memoizes only environment/project IDs while capturing `title`. Include title in the key or join current project metadata outside the atom.

### NIT

Targeted formatting reports nine changed files, including [useWorkflowSidebarEntries.ts:1](/Users/chris/Developer/t3code/apps/web/src/workflow/useWorkflowSidebarEntries.ts:1), [WorkflowCreateCoordinator.tsx:1](/Users/chris/Developer/t3code/apps/web/src/components/WorkflowCreateCoordinator.tsx:1), and [SidebarV2.tsx:1](/Users/chris/Developer/t3code/apps/web/src/components/SidebarV2.tsx:1). Run targeted `vp fmt` before landing.

### MUST checklist

| Check                                               | Result                                                       |
| --------------------------------------------------- | ------------------------------------------------------------ |
| Primary-env ∩ scope before atom construction        | PASS — primary is the catalog `PrimaryConnectionTarget`      |
| One aggregate mount/subscribe + teardown + refresh  | PASS structurally; no leak found                             |
| Partial success / pending / empty                   | **FAIL** — partial errors work, pending/initial empty do not |
| Attention precedence, grouping, sorting             | PASS                                                         |
| Coordinator outside variants, bus, refresh+navigate | PASS structurally, with SHOULD defects above                 |
| Controlled switch and hydration gate                | PASS                                                         |
| Eligible-count Add branching                        | PASS                                                         |
| Test quality                                        | **FAIL**                                                     |
| Contracts/default/patch/desktop parity              | PASS                                                         |

Board-ID collision is not a defect: server discovery and creation generate `${projectId}__${slug}`, so `(environmentId, boardId)` is unique across projects. I found no concrete subscription leak or palette-close race.

Verification: 65/65 focused tests passed; web, contracts, and desktop typechecks passed. No files were changed.
