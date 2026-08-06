You are Grok 4.5 doing a FOCUSED FIX PASS in the t3code repo (/Users/chris/Developer/t3code) on branch feat/sidebar-v2-workflows (already checked out). You built the Sidebar v2 Workflows Mode feature; a GPT-5.6 code review returned FAIL with one remaining MUST finding about TEST QUALITY. The orchestrator (Claude) has ALREADY fixed the two state bugs (false-empty first paint → PENDING_STATE sentinel + effect reset; SWR waiting-overlay → `revalidating` threading into aggregate `pending`) and the three SHOULDs (coordinator unknown-project guard; dialog deferred until the boards query settles; project title included in eligibleKey). DO NOT re-fix or revert any of that. Your job is ONLY the test-strengthening MUST below.

MUST-3 (verbatim from the review):

> Load-bearing tests bypass production wiring. WorkflowCreateCoordinator.test.ts:10 defines a test-only acceptance function that production does not use. WorkflowSidebarList.empty.test.tsx:9 tests a duplicate component. Aggregate tests only call the pure reducer, so they cannot detect findings 1–2 (initial pending, waiting overlay), subscription teardown, or refresh behavior. Nothing tests coordinator placement, bus delivery, dialog opening, invalidation, or navigation.
> Fix: add registry/router-backed component tests using the real hook/list/coordinator.

REPO TEST CONSTRAINTS (binding — follow the existing idioms, do not add new deps):

- apps/web unit tests run in NODE env (no jsdom/happy-dom, no @testing-library). Component tests use `renderToStaticMarkup` from react-dom/server — this means useEffect DOES NOT RUN in component tests. Do not pretend it does.
- The established pattern for registry-backed atom/subscription tests WITHOUT React is `AtomRegistry.make()` — see apps/web/src/state/desktopUpdate.test.ts (uses a real registry: registry.set / registry.subscribe / mount, asserts state transitions and teardown). USE THIS PATTERN for the aggregate.
- vi.mock is available (vite-plus/test). Mocking a HOOK module while rendering the REAL component is acceptable; defining a duplicate copy of the component inside the test is NOT.

WORK ITEMS:

1. useWorkflowSidebarEntries — registry-backed tests of the REAL aggregate atom (apps/web/src/workflow/useWorkflowSidebarEntries.ts). If the aggregate-atom builder is not independently constructible/injectable, extract/export a factory (pure refactor — the hook must keep using the exact same factory) so a test can: build it against a real `AtomRegistry.make()` registry with stubbed source atoms (writable atoms standing in for the per-project listBoards results and the attention result, in the same AsyncResult shapes production reads), then assert:
   a. initial value is the pending sentinel (pending: true, isEmpty: false, no rows) before any source resolves;
   b. Success(waiting=true) on a source (SWR revalidation) keeps aggregate pending true; Success(waiting=false) everywhere → pending false;
   c. Failure(waiting=true) also keeps pending true;
   d. partial success: one project Failure + one Success → rows preserved + errorsByProject entry;
   e. subscription teardown: after unsubscribe/unmount, further source writes do not fire the listener (mirror the desktopUpdate.test.ts teardown assertions).
   If stubbing the true source atoms is impossible without distorting production code, the acceptable fallback is: refactor the builder to take its source atoms as parameters with the production call site supplying the real ones — dependency injection, zero behavior change.
2. WorkflowSidebarList.empty.test.tsx — DELETE the duplicate inline component. Import and SSR-render the REAL WorkflowSidebarList. Under SSR the hook returns its initial snapshot (the pending sentinel), so assert the real component's PENDING state markup that way. For empty/error/populated states, vi.mock the useWorkflowSidebarEntries module (returning each snapshot shape) and render the REAL component — assert empty-state copy, project-error row, board rows + attention badge. Rename the file if it no longer only covers "empty" (e.g. WorkflowSidebarList.states.test.tsx) and remove the old file.
3. WorkflowCreateCoordinator.test.ts — delete the test-only acceptance function. Instead:
   a. Extract the bus-event handler currently inlined in the coordinator's useEffect into an exported pure function (e.g. `resolveCreateWorkflowTarget(detail, projects): target | null`) that the component's effect calls — then test THAT export, including the unknown-project → null guard.
   b. Test the real bus round-trip from apps/web/src/commandPaletteBus.ts: subscribe with the real `onRequestCreateWorkflow`, dispatch with the real `requestCreateWorkflow`, assert the detail arrives and that unsubscribe stops delivery (pure EventTarget — works in node).
   c. SSR-render the REAL coordinator for its render states: no target → null output; target set but boards query unsettled → null (dialog deferred); target + settled boards → CreateWorkflowDialog markup present with the right projectName/existingBoardNames. Use vi.mock for the query hook layer only as needed; keep the component itself real.
4. If any existing test asserted the OLD semantics (initial isEmpty:true, pending:false during revalidation), update it to the new contract — the new contract is correct.

HARD RULES: no `any`, no type casts; do not touch production behavior except the two sanctioned pure extractions (aggregate-atom factory injection in item 1, bus-handler extraction in item 3a) — both must leave runtime behavior byte-identical; do not touch unrelated files; DO NOT commit, DO NOT push.

BEFORE FINISHING: run `cd apps/web && npx tsgo --noEmit` (must be 0 errors) and `npx vitest run` on every test file you touched plus src/workflow/useWorkflowSidebarEntries.test.ts and src/components/WorkflowSidebarList\*.test.tsx and src/components/WorkflowCreateCoordinator.test.ts. Report: files changed, which of the sanctioned extractions you needed, and exact test/typecheck results.
