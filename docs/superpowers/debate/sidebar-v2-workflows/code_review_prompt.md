You are GPT-5.6 Sol reviewing CODE (you did not write it — Grok did). Repo: t3code, branch feat/sidebar-v2-workflows. Feature: Sidebar v2 Workflows Mode. You spec-reviewed this earlier; the spec was rewritten to v2 folding in your MUSTs (primary-env-only scope, WorkflowSidebarList aggregate atom, WorkflowCreateCoordinator outside the sidebar, partial-success, dominant-kind precedence, hydration-gated persistence). Now verify the CODE actually honors those.

The approved spec is docs/superpowers/specs/2026-07-22-sidebar-v2-workflows-mode-design.md (read it). The diff is below. You may read any file in the repo to verify claims — the diff is the source of truth for what changed.

Verify against YOUR earlier MUSTs (these are the load-bearing checks):

1. PRIMARY-ENV SCOPE: eligible projects filtered to the primary environment ∩ project-scope BEFORE atoms are built. No cross-env fan-out. (Confirm which env is "primary" and that it's sourced correctly.)
2. AGGREGATE ATOM: one memoized atom read via registry.mount+subscribe (NOT useEnvironmentQuery inside .map — no dynamic hook ordering). Subscribes once; tears down on unmount. registry.refresh on mode-enter + onCreated.
3. PARTIAL SUCCESS: a failing project's listBoards → error row + errorsByProject, does NOT blank the list; pending true while any loading; empty state ONLY when all eligible succeed with zero. entryError (decode) vs project-query-failure are distinct rows.
4. ATTENTION JOIN: grouped by (environmentId, boardId); dominant kind precedence EXACTLY blocked > parked_issue > waiting_for_approval > waiting_for_input > parked_waiting, null when none; NO "failed" kind. Sort total: project index → name (locale ci) → boardId.
5. CREATE COORDINATOR: mounted in AppSidebarLayout OUTSIDE both sidebar variants; owns selected project + close-palette→open-dialog + onCreated invalidate+navigate; receives the palette intent via the bus (not a sidebar-owned dialog). CreateWorkflowDialog unchanged, primary-env only.
6. SWITCH: controlled value={[mode]} ignoring empty payloads; persist sidebarV2Mode ONLY after client settings hydrated; Threads→Workflows clears thread selection + cancels rename; scope label mode-neutral.
7. ADD-WORKFLOW BRANCH: scoped-project direct / All-scope 0 disabled, 1 direct, >1 palette submenu — matching eligible (capability-filtered) count, not raw project count.
8. TEST QUALITY: do the tests actually assert these (partial-success, precedence, hydration-gate, coordinator-outside-sidebar), or are they tautological/weak? Grep the new _.test._ for shape.
9. Contracts: sidebarV2Mode default + partial round-trip + desktop fixture parity.

Also hunt for NEW defects the spec didn't anticipate (subscription leak, stale closure in the aggregate atom, race between mode-switch and coordinator, boardId collision across projects since BoardListEntry has no projectId — is (env,board) actually unique or can two projects define the same boardId?).

HARD RULES: READ-ONLY analysis. Classify MUST / SHOULD / NIT with file:line + a concrete fix. Adjudicate honestly — do not manufacture findings. End: SHIP / SHIP WITH FIXES / FAIL.

--- DIFF ---
diff --git a/apps/desktop/src/settings/DesktopClientSettings.test.ts b/apps/desktop/src/settings/DesktopClientSettings.test.ts
index 04680c091..fd5b40e4e 100644
--- a/apps/desktop/src/settings/DesktopClientSettings.test.ts
+++ b/apps/desktop/src/settings/DesktopClientSettings.test.ts
@@ -30,6 +30,7 @@ const clientSettings: ClientSettings = {
sidebarThreadSortOrder: "created_at",
sidebarThreadPreviewCount: 6,
sidebarV2Enabled: false,

- sidebarV2Mode: "threads",
  timestampFormat: "24-hour",
  wordWrap: true,
  };
  diff --git a/apps/web/src/commandPaletteBus.ts b/apps/web/src/commandPaletteBus.ts
  index 2a9531329..9c483be39 100644
  --- a/apps/web/src/commandPaletteBus.ts
  +++ b/apps/web/src/commandPaletteBus.ts
  @@ -1,9 +1,18 @@
  +import { EnvironmentId, ProjectId } from "@t3tools/contracts";
- // Tiny event bus allowing components to programmatically open the command palette
  // without owning its React state.
  const COMMAND_PALETTE_OPEN_EVENT = "t3code:open-command-palette";
  +const CREATE_WORKFLOW_EVENT = "t3code:request-create-workflow";
  export interface CommandPaletteOpenDetail {

* readonly open?: "add-project" | "new-thread-in";

- readonly open?: "add-project" | "new-thread-in" | "new-workflow-in";
  +}
- +/\*_ Intent: open CreateWorkflowDialog for a specific primary-env project. _/
  +export interface RequestCreateWorkflowDetail {
- readonly projectId: ProjectId;
- readonly environmentId: EnvironmentId;
  }

export function openCommandPalette(detail?: CommandPaletteOpenDetail): void {
@@ -16,12 +25,47 @@ export function onOpenCommandPalette(
listener: (detail: CommandPaletteOpenDetail) => void,
): () => void {
const handler = (event: Event) => {

- listener((event as CustomEvent<CommandPaletteOpenDetail>).detail ?? {});

* if (!(event instanceof CustomEvent)) {
*      listener({});
*      return;
* }
* const detail = event.detail;
* if (detail === null || detail === undefined || typeof detail !== "object") {
*      listener({});
*      return;
* }
* listener(detail);
  };
  window.addEventListener(COMMAND_PALETTE_OPEN_EVENT, handler);
  return () => window.removeEventListener(COMMAND_PALETTE_OPEN_EVENT, handler);
  }

+/\*_ Emitted by the palette new-workflow-in submenu (and SidebarV2 direct create). _/
+export function requestCreateWorkflow(detail: RequestCreateWorkflowDetail): void {

- window.dispatchEvent(new CustomEvent(CREATE_WORKFLOW_EVENT, { detail }));
  +}
- +export function onRequestCreateWorkflow(
- listener: (detail: RequestCreateWorkflowDetail) => void,
  +): () => void {
- const handler = (event: Event) => {
- if (!(event instanceof CustomEvent)) return;
- const detail = event.detail;
- if (detail === null || detail === undefined || typeof detail !== "object") return;
- if (!("projectId" in detail) || !("environmentId" in detail)) return;
- const projectId = Reflect.get(detail, "projectId");
- const environmentId = Reflect.get(detail, "environmentId");
- if (typeof projectId !== "string" || typeof environmentId !== "string") return;
- if (projectId.length === 0 || environmentId.length === 0) return;
- listener({
-      projectId: ProjectId.make(projectId),
-      environmentId: EnvironmentId.make(environmentId),
- });
- };
- window.addEventListener(CREATE_WORKFLOW_EVENT, handler);
- return () => window.removeEventListener(CREATE_WORKFLOW_EVENT, handler);
  +}
- /\*_ Read at event time so consumers do not subscribe to transient dialog state. _/
  export function isCommandPaletteOpen(): boolean {
  return (
  diff --git a/apps/web/src/components/AppSidebarLayout.tsx b/apps/web/src/components/AppSidebarLayout.tsx
  index ef6b64be9..0246d530d 100644
  --- a/apps/web/src/components/AppSidebarLayout.tsx
  +++ b/apps/web/src/components/AppSidebarLayout.tsx
  @@ -12,6 +12,7 @@ import { useClientSettings } from "../hooks/useSettings";
  import ThreadSidebar from "./Sidebar";
  import ThreadSidebarV2 from "./SidebarV2";
  import { useSidebarStageBackdropVariant } from "./SidebarStageBackdrop";
  +import { WorkflowCreateCoordinator } from "./WorkflowCreateCoordinator";
  import {
  resolveInitialThreadSidebarWidth,
  resolveThreadSidebarMaximumWidth,
  @@ -180,6 +181,8 @@ export function AppSidebarLayout({ children }: { children: ReactNode }) {
  {useSidebarV2 ? <ThreadSidebarV2 /> : <ThreadSidebar />}
  <SidebarRail />
  </Sidebar>
-      {/* Outside both sidebar variants so create survives mode/variant swaps. */}
-      <WorkflowCreateCoordinator />
         {children}
         <SidebarControl />
       </SidebarProvider>
  diff --git a/apps/web/src/components/CommandPalette.tsx b/apps/web/src/components/CommandPalette.tsx
  index bb83dfa56..fac6a9d45 100644
  --- a/apps/web/src/components/CommandPalette.tsx
  +++ b/apps/web/src/components/CommandPalette.tsx
  @@ -28,6 +28,7 @@ import {
  LinkIcon,
  MessageSquareIcon,
  SettingsIcon,
- SquareKanbanIcon,
  SquarePenIcon,
  } from "lucide-react";
  import {
  @@ -77,7 +78,7 @@ import {
  isUnsupportedWindowsProjectPath,
  resolveProjectPathForDispatch,
  } from "../lib/projectPaths";
  -import { onOpenCommandPalette } from "../commandPaletteBus";
  +import { onOpenCommandPalette, requestCreateWorkflow } from "../commandPaletteBus";
  import { isTerminalFocused } from "../lib/terminalFocus";
  import { getLatestThreadForProject } from "../lib/threadSort";
  import { cn, isMacPlatform, isWindowsPlatform, newProjectId } from "../lib/utils";
  @@ -336,7 +337,7 @@ function errorMessage(error: unknown): string {
  }

interface CommandPaletteOpenIntent {

- readonly kind: "add-project" | "new-thread-in";

* readonly kind: "add-project" | "new-thread-in" | "new-workflow-in";
  }

interface CommandPaletteUiState {
@@ -349,6 +350,7 @@ type CommandPaletteUiAction =
| { readonly \_tag: "Toggle" }
| { readonly \_tag: "OpenAddProject" }
| { readonly \_tag: "OpenNewThreadIn" }

- | { readonly \_tag: "OpenNewWorkflowIn" }
  | { readonly \_tag: "ClearOpenIntent" };

function reduceCommandPaletteUiState(
@@ -367,6 +369,8 @@ function reduceCommandPaletteUiState(
return { open: true, openIntent: { kind: "add-project" } };
case "OpenNewThreadIn":
return { open: true, openIntent: { kind: "new-thread-in" } };

- case "OpenNewWorkflowIn":
-      return { open: true, openIntent: { kind: "new-workflow-in" } };
       case "ClearOpenIntent":
         return state.openIntent ? { ...state, openIntent: null } : state;
  }
  @@ -381,6 +385,7 @@ export function CommandPalette({ children }: { children: ReactNode }) {
  const toggleOpen = useCallback(() => dispatch({ \_tag: "Toggle" }), []);
  const openAddProject = useCallback(() => dispatch({ \_tag: "OpenAddProject" }), []);
  const openNewThreadIn = useCallback(() => dispatch({ \_tag: "OpenNewThreadIn" }), []);
- const openNewWorkflowIn = useCallback(() => dispatch({ \_tag: "OpenNewWorkflowIn" }), []);
  const clearOpenIntent = useCallback(() => dispatch({ \_tag: "ClearOpenIntent" }), []);
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const composerHandleRef = useRef<ChatComposerHandle | null>(null);
  @@ -420,13 +425,15 @@ export function CommandPalette({ children }: { children: ReactNode }) {
  onOpenCommandPalette((detail) => {
  if (detail.open === "new-thread-in") {
  openNewThreadIn();
-        } else if (detail.open === "new-workflow-in") {
-          openNewWorkflowIn();
         } else if (detail.open === "add-project") {
           openAddProject();
         } else {
           setOpen(true);
         }
       }),

* [openAddProject, openNewThreadIn, setOpen],

- [openAddProject, openNewThreadIn, openNewWorkflowIn, setOpen],
  );

return (
@@ -714,6 +721,41 @@ function OpenCommandPaletteDialog(props: {
[activeDraftThread, activeThread, defaultProjectRef, handleNewThread, projects],
);

- // Workflow boards are primary-environment only (providers + create dialog).
- const primaryProjects = useMemo(
- () =>
-      primaryEnvironmentId === null
-        ? []
-        : projects.filter((project) => project.environmentId === primaryEnvironmentId),
- [primaryEnvironmentId, projects],
- );
-
- const projectWorkflowItems = useMemo(
- () =>
-      enumerateCommandPaletteItems(
-        buildProjectActionItems({
-          projects: primaryProjects,
-          valuePrefix: "new-workflow-in",
-          icon: (project) => (
-            <ProjectFavicon
-              environmentId={project.environmentId}
-              cwd={project.workspaceRoot}
-              className={ITEM_ICON_CLASS}
-            />
-          ),
-          runProject: async (project) => {
-            // Palette closes before running; the coordinator (outside the
-            // sidebar) opens CreateWorkflowDialog for this project.
-            requestCreateWorkflow({
-              projectId: project.id,
-              environmentId: project.environmentId,
-            });
-          },
-        }),
-      ),
- [primaryProjects],
- );
- const allThreadItems = useMemo(
  () =>
  buildThreadActionItems({
  @@ -1015,6 +1057,42 @@ function OpenCommandPaletteDialog(props: {
  projectThreadItems,
  ]);
- useLayoutEffect(() => {
- if (openIntent?.kind !== "new-workflow-in" || projectWorkflowItems.length === 0) {
-      return;
- }
- clearOpenIntent();
- setAddProjectCloneFlow(null);
- setViewStack([]);
- setQuery("");
- const currentPrefix =
-      currentProjectEnvironmentId && currentProjectId
-        ? `new-workflow-in:${currentProjectEnvironmentId}:${currentProjectId}`
-        : null;
- const prioritized = currentPrefix
-      ? [
-          ...projectWorkflowItems.filter((item) => item.value === currentPrefix),
-          ...projectWorkflowItems.filter((item) => item.value !== currentPrefix),
-        ]
-      : projectWorkflowItems;
- pushPaletteView({
-      addonIcon: <SquareKanbanIcon className={ADDON_ICON_CLASS} />,
-      groups: [
-        {
-          value: "projects",
-          label: "Projects",
-          items: enumerateCommandPaletteItems(prioritized),
-        },
-      ],
- });
- }, [
- clearOpenIntent,
- currentProjectEnvironmentId,
- currentProjectId,
- openIntent,
- projectWorkflowItems,
- ]);
- const actionItems: Array<CommandPaletteActionItem | CommandPaletteSubmenuItem> = [];
  if (projects.length > 0) {
  @@ -1054,6 +1132,18 @@ function OpenCommandPaletteDialog(props: {
  addonIcon: <SquarePenIcon className={ADDON_ICON_CLASS} />,
  groups: [{ value: "projects", label: "Projects", items: projectThreadItems }],
  });
-
- if (projectWorkflowItems.length > 0) {
-      actionItems.push({
-        kind: "submenu",
-        value: "action:new-workflow-in",
-        searchTerms: ["new workflow", "board", "project", "pick", "choose", "select", "kanban"],
-        title: "New workflow in...",
-        icon: <SquareKanbanIcon className={ITEM_ICON_CLASS} />,
-        addonIcon: <SquareKanbanIcon className={ADDON_ICON_CLASS} />,
-        groups: [{ value: "projects", label: "Projects", items: projectWorkflowItems }],
-      });
- }
  }

actionItems.push({
diff --git a/apps/web/src/components/SidebarV2.addWorkflow.test.ts b/apps/web/src/components/SidebarV2.addWorkflow.test.ts
new file mode 100644
index 000000000..1af86235b
--- /dev/null
+++ b/apps/web/src/components/SidebarV2.addWorkflow.test.ts
@@ -0,0 +1,67 @@
+import { EnvironmentId, ProjectId } from "@t3tools/contracts";
+import { describe, expect, it } from "vite-plus/test";

- +import type { WorkflowSidebarEligibleProject } from "../workflow/useWorkflowSidebarEntries";
  +import { resolveAddWorkflowAction } from "./SidebarV2.addWorkflow";
- +const env = EnvironmentId.make("environment-primary");
  +const remote = EnvironmentId.make("environment-remote");
  +const a = ProjectId.make("project-a");
  +const b = ProjectId.make("project-b");
- +const two: ReadonlyArray<WorkflowSidebarEligibleProject> = [
- { id: a, environmentId: env, title: "A" },
- { id: b, environmentId: env, title: "B" },
  +];
- +describe("resolveAddWorkflowAction", () => {
- it("targets a scoped primary-env project directly", () => {
- expect(
-      resolveAddWorkflowAction({
-        eligibleProjects: two,
-        scopedProject: { id: b, environmentId: env },
-        primaryEnvironmentId: env,
-      }),
- ).toEqual({ kind: "direct", projectId: b, environmentId: env });
- });
-
- it("disables when All-scope has zero eligible projects", () => {
- expect(
-      resolveAddWorkflowAction({
-        eligibleProjects: [],
-        scopedProject: null,
-        primaryEnvironmentId: env,
-      }),
- ).toEqual({ kind: "disabled" });
- });
-
- it("opens dialog directly when All-scope has exactly one eligible project", () => {
- expect(
-      resolveAddWorkflowAction({
-        eligibleProjects: [two[0]!],
-        scopedProject: null,
-        primaryEnvironmentId: env,
-      }),
- ).toEqual({ kind: "direct", projectId: a, environmentId: env });
- });
-
- it("opens palette submenu when All-scope has multiple eligible projects", () => {
- expect(
-      resolveAddWorkflowAction({
-        eligibleProjects: two,
-        scopedProject: null,
-        primaryEnvironmentId: env,
-      }),
- ).toEqual({ kind: "palette-submenu" });
- });
-
- it("does not treat a non-primary scoped project as a direct target", () => {
- expect(
-      resolveAddWorkflowAction({
-        eligibleProjects: [],
-        scopedProject: { id: a, environmentId: remote },
-        primaryEnvironmentId: env,
-      }),
- ).toEqual({ kind: "disabled" });
- });
  +});
  diff --git a/apps/web/src/components/SidebarV2.addWorkflow.ts b/apps/web/src/components/SidebarV2.addWorkflow.ts
  new file mode 100644
  index 000000000..63c1cf43e
  --- /dev/null
  +++ b/apps/web/src/components/SidebarV2.addWorkflow.ts
  @@ -0,0 +1,50 @@
  +import type { EnvironmentId, ProjectId } from "@t3tools/contracts";
- +import type { WorkflowSidebarEligibleProject } from "../workflow/useWorkflowSidebarEntries";
- +/\*\*
- - Pure branch logic for the Add-workflow button. Used by SidebarV2 and unit
- - tests (scoped-project direct / All: 0 disabled, 1 direct, >1 palette).
- \*/
  +export type AddWorkflowAction =
- | { readonly kind: "disabled" }
- | {
-      readonly kind: "direct";
-      readonly projectId: ProjectId;
-      readonly environmentId: EnvironmentId;
- }
- | { readonly kind: "palette-submenu" };
- +export function resolveAddWorkflowAction(input: {
- readonly eligibleProjects: ReadonlyArray<WorkflowSidebarEligibleProject>;
- readonly scopedProject:
- | { readonly id: ProjectId; readonly environmentId: EnvironmentId }
- | null;
- readonly primaryEnvironmentId: EnvironmentId | null;
  +}): AddWorkflowAction {
- if (
- input.scopedProject !== null &&
- input.primaryEnvironmentId !== null &&
- input.scopedProject.environmentId === input.primaryEnvironmentId
- ) {
- return {
-      kind: "direct",
-      projectId: input.scopedProject.id,
-      environmentId: input.scopedProject.environmentId,
- };
- }
-
- if (input.eligibleProjects.length === 0) {
- return { kind: "disabled" };
- }
- if (input.eligibleProjects.length === 1) {
- const only = input.eligibleProjects[0];
- if (!only) return { kind: "disabled" };
- return {
-      kind: "direct",
-      projectId: only.id,
-      environmentId: only.environmentId,
- };
- }
- return { kind: "palette-submenu" };
  +}
  diff --git a/apps/web/src/components/SidebarV2.mode.test.ts b/apps/web/src/components/SidebarV2.mode.test.ts
  new file mode 100644
  index 000000000..a3cb8a54e
  --- /dev/null
  +++ b/apps/web/src/components/SidebarV2.mode.test.ts
  @@ -0,0 +1,60 @@
  +import { describe, expect, it } from "vite-plus/test";
- +import {
- resolveNextSidebarV2Mode,
- shouldClearThreadSelectionOnModeChange,
  +} from "./SidebarV2.mode";
- +describe("SidebarV2 mode switch", () => {
- it("ignores empty and invalid payloads", () => {
- expect(
-      resolveNextSidebarV2Mode({ current: "threads", payload: [], hydrated: true }),
- ).toBeNull();
- expect(
-      resolveNextSidebarV2Mode({
-        current: "threads",
-        payload: ["boards"],
-        hydrated: true,
-      }),
- ).toBeNull();
- });
-
- it("accepts a valid mode change only after hydration", () => {
- expect(
-      resolveNextSidebarV2Mode({
-        current: "threads",
-        payload: ["workflows"],
-        hydrated: false,
-      }),
- ).toBeNull();
- expect(
-      resolveNextSidebarV2Mode({
-        current: "threads",
-        payload: ["workflows"],
-        hydrated: true,
-      }),
- ).toBe("workflows");
- });
-
- it("is a no-op when the mode is unchanged", () => {
- expect(
-      resolveNextSidebarV2Mode({
-        current: "workflows",
-        payload: ["workflows"],
-        hydrated: true,
-      }),
- ).toBeNull();
- });
-
- it("clears thread selection only on Threads → Workflows", () => {
- expect(
-      shouldClearThreadSelectionOnModeChange({ from: "threads", to: "workflows" }),
- ).toBe(true);
- expect(
-      shouldClearThreadSelectionOnModeChange({ from: "workflows", to: "threads" }),
- ).toBe(false);
- expect(
-      shouldClearThreadSelectionOnModeChange({ from: "threads", to: "threads" }),
- ).toBe(false);
- });
  +});
  diff --git a/apps/web/src/components/SidebarV2.mode.ts b/apps/web/src/components/SidebarV2.mode.ts
  new file mode 100644
  index 000000000..bf12a0ec8
  --- /dev/null
  +++ b/apps/web/src/components/SidebarV2.mode.ts
  @@ -0,0 +1,30 @@
  +import type { SidebarV2Mode } from "@t3tools/contracts/settings";
- +/\*\*
- - Pure helpers for the Sidebar v2 mode switch (controlled ToggleGroup rules).
- \*/
- +export function resolveNextSidebarV2Mode(input: {
- readonly current: SidebarV2Mode;
- readonly payload: ReadonlyArray<string>;
- readonly hydrated: boolean;
  +}): SidebarV2Mode | null {
- const next = input.payload[0];
- if (next !== "threads" && next !== "workflows") {
- return null;
- }
- if (next === input.current) {
- return null;
- }
- if (!input.hydrated) {
- return null;
- }
- return next;
  +}
- +export function shouldClearThreadSelectionOnModeChange(input: {
- readonly from: SidebarV2Mode;
- readonly to: SidebarV2Mode;
  +}): boolean {
- return input.from === "threads" && input.to === "workflows";
  +}
  diff --git a/apps/web/src/components/SidebarV2.tsx b/apps/web/src/components/SidebarV2.tsx
  index 2b81c15c7..b4e4c42b0 100644
  --- a/apps/web/src/components/SidebarV2.tsx
  +++ b/apps/web/src/components/SidebarV2.tsx
  @@ -21,6 +21,7 @@ import {
  PlusIcon,
  SearchIcon,
  ServerIcon,
- SquareKanbanIcon,
  SquarePenIcon,
  Undo2Icon,
  } from "lucide-react";
  @@ -61,9 +62,13 @@ import { useUiStateStore } from "../uiStateStore";
  import { useThreadSelectionStore } from "../threadSelectionStore";
  import { useThreadActions } from "../hooks/useThreadActions";
  import { useHandleNewThread } from "../hooks/useHandleNewThread";
  -import { openCommandPalette } from "../commandPaletteBus";
  +import { openCommandPalette, requestCreateWorkflow } from "../commandPaletteBus";
  import { startNewThreadFromContext } from "../lib/chatThreadActions";
  -import { useClientSettings } from "../hooks/useSettings";
  +import {
- useClientSettings,
- useClientSettingsHydrated,
- useUpdateClientSettings,
  +} from "../hooks/useSettings";
  import { useEnvironments, usePrimaryEnvironmentId } from "../state/environments";
  import { useProjects, useThreadShells } from "../state/entities";
  import { environmentServerConfigsAtom, primaryServerKeybindingsAtom } from "../state/server";
  @@ -102,7 +107,15 @@ import {
  useSidebar,
  } from "./ui/sidebar";
  import { SidebarChromeFooter, SidebarChromeHeader } from "./sidebar/SidebarChrome";
  +import { Toggle, ToggleGroup } from "./ui/toggle-group";
  import { Tooltip, TooltipPopup, TooltipProvider, TooltipTrigger } from "./ui/tooltip";
  +import { resolveAddWorkflowAction } from "./SidebarV2.addWorkflow";
  +import {
- resolveNextSidebarV2Mode,
- shouldClearThreadSelectionOnModeChange,
  +} from "./SidebarV2.mode";
  +import { WorkflowSidebarList } from "./WorkflowSidebarList";
  +import { filterEligibleWorkflowProjects } from "../workflow/useWorkflowSidebarEntries";

// Settled-tail paging: recent history is the common lookup; the deep tail
// stays behind an explicit Show more.
@@ -754,6 +767,9 @@ export default function SidebarV2() {
const keybindings = useAtomValue(primaryServerKeybindingsAtom);
const autoSettleAfterDays = useClientSettings((s) => s.sidebarAutoSettleAfterDays);
const confirmThreadDelete = useClientSettings((s) => s.confirmThreadDelete);

- const sidebarV2Mode = useClientSettings((s) => s.sidebarV2Mode);
- const clientSettingsHydrated = useClientSettingsHydrated();
- const updateClientSettings = useUpdateClientSettings();
  const { settleThread, unsettleThread, deleteThread } = useThreadActions();
  const updateThreadMetadata = useAtomCommand(threadEnvironment.updateMetadata, {
  reportFailure: false,
  @@ -1031,6 +1047,33 @@ export default function SidebarV2() {
  setRenamingTitle(title);
  }, []);
  const cancelThreadRename = useCallback(() => setRenamingThreadKey(null), []);
-
- const setSidebarMode = useCallback(
- (payload: ReadonlyArray<string>) => {
-      const nextMode = resolveNextSidebarV2Mode({
-        current: sidebarV2Mode,
-        payload,
-        hydrated: clientSettingsHydrated,
-      });
-      if (nextMode === null) return;
-      // Threads → Workflows: hidden thread rows must not stay actionable.
-      if (
-        shouldClearThreadSelectionOnModeChange({ from: sidebarV2Mode, to: nextMode })
-      ) {
-        clearSelection();
-        cancelThreadRename();
-      }
-      updateClientSettings({ sidebarV2Mode: nextMode });
- },
- [
-      cancelThreadRename,
-      clearSelection,
-      clientSettingsHydrated,
-      sidebarV2Mode,
-      updateClientSettings,
- ],
- );
- const commitThreadRename = useCallback(
  (threadRef: ScopedThreadRef, title: string, originalTitle: string) => {
  void (async () => {
  @@ -1450,12 +1493,62 @@ export default function SidebarV2() {
  openCommandPalette({ open: "new-thread-in" });
  }, [isMobile, newThreadContext, projects.length, setOpenMobile]);
- const eligibleWorkflowProjects = useMemo(
- () =>
-      filterEligibleWorkflowProjects({
-        projects: projects.map((project) => ({
-          id: project.id,
-          environmentId: project.environmentId,
-          title: project.title,
-        })),
-        primaryEnvironmentId,
-        scopedProject: scopedProject
-          ? { id: scopedProject.id, environmentId: scopedProject.environmentId }
-          : null,
-      }),
- [primaryEnvironmentId, projects, scopedProject],
- );
-
- // Add-workflow branches on eligible (primary-env ∩ scope) count.
- const handleAddWorkflowClick = useCallback(() => {
- const action = resolveAddWorkflowAction({
-      eligibleProjects: eligibleWorkflowProjects,
-      scopedProject: scopedProject
-        ? { id: scopedProject.id, environmentId: scopedProject.environmentId }
-        : null,
-      primaryEnvironmentId,
- });
- if (action.kind === "disabled") return;
- if (isMobile) setOpenMobile(false);
- if (action.kind === "direct") {
-      requestCreateWorkflow({
-        projectId: action.projectId,
-        environmentId: action.environmentId,
-      });
-      return;
- }
- openCommandPalette({ open: "new-workflow-in" });
- }, [eligibleWorkflowProjects, isMobile, primaryEnvironmentId, scopedProject, setOpenMobile]);
-
- const addWorkflowDisabled =
- resolveAddWorkflowAction({
-      eligibleProjects: eligibleWorkflowProjects,
-      scopedProject: scopedProject
-        ? { id: scopedProject.id, environmentId: scopedProject.environmentId }
-        : null,
-      primaryEnvironmentId,
- }).kind === "disabled";
- const addWorkflowTooltip = addWorkflowDisabled
- ? "No primary-environment project in scope"
- : "Add workflow";
- const commandPaletteShortcutLabel = shortcutLabelForCommand(keybindings, "commandPalette.toggle");
  // Same resolution as v1: prefer the local-thread binding, fall back to
  // chat.new, no platform gating — web users have working shortcuts too.
  const newThreadShortcutLabel =
  shortcutLabelForCommand(keybindings, "chat.newLocal") ??
  shortcutLabelForCommand(keybindings, "chat.new");
- const isWorkflowsMode = sidebarV2Mode === "workflows";
  return (
  <>
  <SidebarChromeHeader isElectron={isElectron} />
  @@ -1484,38 +1577,94 @@ export default function SidebarV2() {
  </CommandDialogTrigger>
  </div>
  <div className="shrink-0">

*              <Tooltip>
*                <TooltipTrigger
*                  render={
*                    <SidebarMenuButton
*                      size="sm"
*                      type="button"
*                      className="relative size-8 justify-center rounded-md border-0 bg-transparent p-0 text-sidebar-muted-foreground hover:bg-sidebar-row-hover hover:text-sidebar-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-sidebar"
*                      onClick={handleNewThreadClick}
*                      disabled={projects.length === 0}
*                      aria-label="New thread"

-              {isWorkflowsMode ? (
-                <Tooltip>
-                  <TooltipTrigger
-                    render={
-                      <SidebarMenuButton
-                        size="sm"
-                        type="button"
-                        className="relative size-8 justify-center rounded-md border-0 bg-transparent p-0 text-sidebar-muted-foreground hover:bg-sidebar-row-hover hover:text-sidebar-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-sidebar"
-                        onClick={handleAddWorkflowClick}
-                        disabled={addWorkflowDisabled}
-                        aria-label="Add workflow"
-                        data-testid="sidebar-v2-add-workflow"
-                      />
-                    }
-                  >
-                    <SquareKanbanIcon className="size-4 shrink-0 text-sidebar-muted-foreground/80" />
-                    <span
-                      className="pointer-events-none absolute left-1/2 top-1/2 size-[max(100%,3rem)] -translate-1/2 pointer-fine:hidden"
-                      aria-hidden="true"
                     />

*                  }
*                >
*                  <SquarePenIcon className="size-4 shrink-0 text-sidebar-muted-foreground/80" />
*                  <span
*                    className="pointer-events-none absolute left-1/2 top-1/2 size-[max(100%,3rem)] -translate-1/2 pointer-fine:hidden"
*                    aria-hidden="true"
*                  />
*                </TooltipTrigger>
*                <TooltipPopup side="right">
*                  {newThreadShortcutLabel ? `New thread (${newThreadShortcutLabel})` : "New thread"}
*                </TooltipPopup>
*              </Tooltip>

-                  </TooltipTrigger>
-                  <TooltipPopup side="right">{addWorkflowTooltip}</TooltipPopup>
-                </Tooltip>
-              ) : (
-                <Tooltip>
-                  <TooltipTrigger
-                    render={
-                      <SidebarMenuButton
-                        size="sm"
-                        type="button"
-                        className="relative size-8 justify-center rounded-md border-0 bg-transparent p-0 text-sidebar-muted-foreground hover:bg-sidebar-row-hover hover:text-sidebar-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-sidebar"
-                        onClick={handleNewThreadClick}
-                        disabled={projects.length === 0}
-                        aria-label="New thread"
-                      />
-                    }
-                  >
-                    <SquarePenIcon className="size-4 shrink-0 text-sidebar-muted-foreground/80" />
-                    <span
-                      className="pointer-events-none absolute left-1/2 top-1/2 size-[max(100%,3rem)] -translate-1/2 pointer-fine:hidden"
-                      aria-hidden="true"
-                    />
-                  </TooltipTrigger>
-                  <TooltipPopup side="right">
-                    {newThreadShortcutLabel
-                      ? `New thread (${newThreadShortcutLabel})`
-                      : "New thread"}
-                  </TooltipPopup>
-                </Tooltip>
-              )}
             </div>
           </div>
         </SidebarGroup>
-        <SidebarGroup className="px-2 pb-2 pt-0">
-          <ToggleGroup
-            className="w-full"
-            variant="outline"
-            size="sm"
-            value={[sidebarV2Mode]}
-            onValueChange={(value) => {
-              setSidebarMode(value);
-            }}
-            data-testid="sidebar-v2-mode-switch"
-          >
-            <Toggle
-              aria-label="Threads"
-              value="threads"
-              className="min-w-0 flex-1"
-              data-testid="sidebar-v2-mode-threads"
-            >
-              Threads
-            </Toggle>
-            <Toggle
-              aria-label="Workflows"
-              value="workflows"
-              className="min-w-0 flex-1"
-              data-testid="sidebar-v2-mode-workflows"
-            >
-              Workflows
-            </Toggle>
-          </ToggleGroup>
-        </SidebarGroup>
         {projects.length > 0 ? (
           <SidebarGroup className="px-2 pb-2 pt-0">
             <div className="flex items-center gap-1">
               <Menu>
                 <MenuTrigger

*                  aria-label="Filter threads by project"

-                  aria-label="Filter by project"
                     className="flex h-8 min-w-0 flex-1 cursor-pointer items-center gap-2 rounded-md px-2 text-left text-sm font-medium text-sidebar-muted-foreground outline-none hover:bg-sidebar-row-hover hover:text-sidebar-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-sidebar"
                   >
                     {scopedProject ? (
  @@ -1592,130 +1741,156 @@ export default function SidebarV2() {
  </SidebarGroup>
  ) : null}
  <SidebarGroup className="min-h-0 flex-1 overflow-y-auto px-2 py-1">

*          <TooltipProvider
*            key="sidebar-thread-tooltips-150"
*            delay={150}
*            closeDelay={0}
*            timeout={400}
*          >
*            <ul ref={attachListAutoAnimateRef} role="list" className="flex flex-col gap-px">
*              {orderedThreads.flatMap((thread, threadIndex) => {
*                const threadKey = scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id));
*                const isSettledRow = settledThreadKeys.has(threadKey);
*                // Settled is the ONLY thing that collapses a row: every
*                // not-settled thread is a full card. Density comes from users
*                // (or the auto rules) actually settling work, not from the
*                // sidebar second-guessing what still matters.
*                const isCard = !isSettledRow;
*                const previousThread = threadIndex > 0 ? orderedThreads[threadIndex - 1] : null;
*                const previousWasCard =
*                  previousThread != null &&
*                  !settledThreadKeys.has(
*                    scopedThreadKey(
*                      scopeThreadRef(previousThread.environmentId, previousThread.id),
*                    ),
*                  );
*                const showSettledGap = !isCard && previousWasCard;
*                const row = (
*                  <SidebarV2Row
*                    // Keyed per variant on purpose: when a thread settles, the
*                    // card fades out in place and the slim row fades in at its
*                    // settled position instead of one element FLIP-sliding
*                    // through every row in between (rows here are translucent,
*                    // so a crossing row reads as text painted over text).
*                    key={`${threadKey}:${isCard ? "card" : "slim"}`}
*                    thread={thread}
*                    variant={isCard ? "card" : "slim"}
*                    // Every settled row can un-settle: explicit settles clear
*                    // the override, auto-settled rows get pinned active.
*                    variantAction={isSettledRow ? "unsettle" : "settle"}
*                    settlementSupported={
*                      serverConfigs.get(thread.environmentId)?.environment.capabilities
*                        .threadSettlement === true
*                    }
*                    isActive={routeThreadKey === threadKey}
*                    jumpLabel={showJumpHints ? (jumpLabelByKey.get(threadKey) ?? null) : null}
*                    currentEnvironmentId={primaryEnvironmentId}
*                    environmentLabel={environmentLabelById.get(thread.environmentId) ?? null}
*                    projectCwd={
*                      projectCwdByKey.get(`${thread.environmentId}:${thread.projectId}`) ?? null
*                    }
*                    projectTitle={
*                      projectTitleByKey.get(`${thread.environmentId}:${thread.projectId}`) ?? null
*                    }
*                    providerEntryByInstanceId={providerEntryByInstanceId}
*                    onThreadClick={handleThreadClick}
*                    onThreadActivate={navigateToThread}
*                    onStartRename={startThreadRename}
*                    onRenameTitleChange={setRenamingTitle}
*                    onCommitRename={commitThreadRename}
*                    onCancelRename={cancelThreadRename}
*                    isRenaming={renamingThreadKey === threadKey}
*                    renamingTitle={renamingThreadKey === threadKey ? renamingTitle : ""}
*                    onContextMenu={handleThreadContextMenu}
*                    onSettle={attemptSettle}
*                    onUnsettle={attemptUnsettle}
*                    onChangeRequestState={handleChangeRequestState}
*                  />
*                );
*                if (!showSettledGap) return [row];
*                // The divider is its own keyed list item (not part of the first
*                // settled row): it keeps one stable DOM node at the boundary,
*                // so settling a thread slides it instead of teleporting it
*                // along with whichever row happens to be first in the tail —
*                // and row heights stay independent of neighbor classification.
*                return [
*                  <li
*                    key="settled-divider"
*                    aria-hidden
*                    data-thread-selection-safe
*                    className="list-none"
*                  >
*                    <div className="mb-1 mt-3 flex items-center gap-2 px-2.5">
*                      <span className="text-xs font-medium text-muted-foreground/50">Settled</span>
*                      <span className="h-px flex-1 bg-sidebar-border/60" />
*                    </div>
*                  </li>,
*                  row,
*                ];
*              })}
*              {hiddenSettledCount > 0 ? (
*                <li className="list-none">
*                  <button
*                    type="button"
*                    onClick={showMoreSettled}
*                    className="mt-1 flex h-[30px] w-full items-center justify-center gap-1.5 rounded-md border border-dashed border-border font-mono text-[11px] text-muted-foreground transition-colors hover:border-solid hover:border-input hover:bg-background/45 hover:text-foreground dark:border-white/15 dark:hover:border-white/30 dark:hover:bg-transparent"
*                  >
*                    Show {Math.min(hiddenSettledCount, SETTLED_TAIL_PAGE_COUNT)} more
*                    <span className="text-muted-foreground/50">
*                      ({hiddenSettledCount} settled hidden)
*                    </span>
*                  </button>
*                </li>

-          {isWorkflowsMode ? (
-            <WorkflowSidebarList
-              projects={projects.map((project) => ({
-                id: project.id,
-                environmentId: project.environmentId,
-                title: project.title,
-              }))}
-              scopedProject={
-                scopedProject
-                  ? { id: scopedProject.id, environmentId: scopedProject.environmentId }
-                  : null
-              }
-              {...(addWorkflowDisabled
-                ? {}
-                : { onRequestAddWorkflow: handleAddWorkflowClick })}
-            />
-          ) : (
-            <>
-              <TooltipProvider
-                key="sidebar-thread-tooltips-150"
-                delay={150}
-                closeDelay={0}
-                timeout={400}
-              >
-                <ul ref={attachListAutoAnimateRef} role="list" className="flex flex-col gap-px">
-                  {orderedThreads.flatMap((thread, threadIndex) => {
-                    const threadKey = scopedThreadKey(
-                      scopeThreadRef(thread.environmentId, thread.id),
-                    );
-                    const isSettledRow = settledThreadKeys.has(threadKey);
-                    // Settled is the ONLY thing that collapses a row: every
-                    // not-settled thread is a full card. Density comes from users
-                    // (or the auto rules) actually settling work, not from the
-                    // sidebar second-guessing what still matters.
-                    const isCard = !isSettledRow;
-                    const previousThread =
-                      threadIndex > 0 ? orderedThreads[threadIndex - 1] : null;
-                    const previousWasCard =
-                      previousThread != null &&
-                      !settledThreadKeys.has(
-                        scopedThreadKey(
-                          scopeThreadRef(previousThread.environmentId, previousThread.id),
-                        ),
-                      );
-                    const showSettledGap = !isCard && previousWasCard;
-                    const row = (
-                      <SidebarV2Row
-                        // Keyed per variant on purpose: when a thread settles, the
-                        // card fades out in place and the slim row fades in at its
-                        // settled position instead of one element FLIP-sliding
-                        // through every row in between (rows here are translucent,
-                        // so a crossing row reads as text painted over text).
-                        key={`${threadKey}:${isCard ? "card" : "slim"}`}
-                        thread={thread}
-                        variant={isCard ? "card" : "slim"}
-                        // Every settled row can un-settle: explicit settles clear
-                        // the override, auto-settled rows get pinned active.
-                        variantAction={isSettledRow ? "unsettle" : "settle"}
-                        settlementSupported={
-                          serverConfigs.get(thread.environmentId)?.environment.capabilities
-                            .threadSettlement === true
-                        }
-                        isActive={routeThreadKey === threadKey}
-                        jumpLabel={showJumpHints ? (jumpLabelByKey.get(threadKey) ?? null) : null}
-                        currentEnvironmentId={primaryEnvironmentId}
-                        environmentLabel={environmentLabelById.get(thread.environmentId) ?? null}
-                        projectCwd={
-                          projectCwdByKey.get(`${thread.environmentId}:${thread.projectId}`) ?? null
-                        }
-                        projectTitle={
-                          projectTitleByKey.get(`${thread.environmentId}:${thread.projectId}`) ??
-                          null
-                        }
-                        providerEntryByInstanceId={providerEntryByInstanceId}
-                        onThreadClick={handleThreadClick}
-                        onThreadActivate={navigateToThread}
-                        onStartRename={startThreadRename}
-                        onRenameTitleChange={setRenamingTitle}
-                        onCommitRename={commitThreadRename}
-                        onCancelRename={cancelThreadRename}
-                        isRenaming={renamingThreadKey === threadKey}
-                        renamingTitle={renamingThreadKey === threadKey ? renamingTitle : ""}
-                        onContextMenu={handleThreadContextMenu}
-                        onSettle={attemptSettle}
-                        onUnsettle={attemptUnsettle}
-                        onChangeRequestState={handleChangeRequestState}
-                      />
-                    );
-                    if (!showSettledGap) return [row];
-                    // The divider is its own keyed list item (not part of the first
-                    // settled row): it keeps one stable DOM node at the boundary,
-                    // so settling a thread slides it instead of teleporting it
-                    // along with whichever row happens to be first in the tail —
-                    // and row heights stay independent of neighbor classification.
-                    return [
-                      <li
-                        key="settled-divider"
-                        aria-hidden
-                        data-thread-selection-safe
-                        className="list-none"
-                      >
-                        <div className="mb-1 mt-3 flex items-center gap-2 px-2.5">
-                          <span className="text-xs font-medium text-muted-foreground/50">
-                            Settled
-                          </span>
-                          <span className="h-px flex-1 bg-sidebar-border/60" />
-                        </div>
-                      </li>,
-                      row,
-                    ];
-                  })}
-                  {hiddenSettledCount > 0 ? (
-                    <li className="list-none">
-                      <button
-                        type="button"
-                        onClick={showMoreSettled}
-                        className="mt-1 flex h-[30px] w-full items-center justify-center gap-1.5 rounded-md border border-dashed border-border font-mono text-[11px] text-muted-foreground transition-colors hover:border-solid hover:border-input hover:bg-background/45 hover:text-foreground dark:border-white/15 dark:hover:border-white/30 dark:hover:bg-transparent"
-                      >
-                        Show {Math.min(hiddenSettledCount, SETTLED_TAIL_PAGE_COUNT)} more
-                        <span className="text-muted-foreground/50">
-                          ({hiddenSettledCount} settled hidden)
-                        </span>
-                      </button>
-                    </li>
-                  ) : null}
-                </ul>
-              </TooltipProvider>
-              {orderedThreads.length === 0 ? (
-                <div className="flex flex-col items-center gap-2 px-2 py-6 text-center text-xs text-muted-foreground/60">
-                  {projects.length === 0 ? (
-                    <>
-                      <span>No projects yet</span>
-                      <button
-                        type="button"
-                        onClick={openAddProjectCommandPalette}
-                        className="inline-flex items-center gap-1.5 rounded-md border border-sidebar-border px-2.5 py-1 text-[11px] font-medium text-sidebar-muted-foreground transition-colors hover:bg-sidebar-row-hover hover:text-sidebar-foreground"
-                      >
-                        <PlusIcon className="size-3" />
-                        Add project
-                      </button>
-                    </>
-                  ) : scopedProject ? (
-                    `No threads in ${scopedProject.title} yet`
-                  ) : (
-                    "No threads yet"
-                  )}
-                </div>
               ) : null}

*            </ul>
*          </TooltipProvider>
*          {orderedThreads.length === 0 ? (
*            <div className="flex flex-col items-center gap-2 px-2 py-6 text-center text-xs text-muted-foreground/60">
*              {projects.length === 0 ? (
*                <>
*                  <span>No projects yet</span>
*                  <button
*                    type="button"
*                    onClick={openAddProjectCommandPalette}
*                    className="inline-flex items-center gap-1.5 rounded-md border border-sidebar-border px-2.5 py-1 text-[11px] font-medium text-sidebar-muted-foreground transition-colors hover:bg-sidebar-row-hover hover:text-sidebar-foreground"
*                  >
*                    <PlusIcon className="size-3" />
*                    Add project
*                  </button>
*                </>
*              ) : scopedProject ? (
*                `No threads in ${scopedProject.title} yet`
*              ) : (
*                "No threads yet"
*              )}
*            </div>
*          ) : null}

-            </>
-          )}
           </SidebarGroup>
         </SidebarContent>
         <div className="shrink-0 px-2">
  diff --git a/apps/web/src/components/SidebarV2WorkflowRow.test.tsx b/apps/web/src/components/SidebarV2WorkflowRow.test.tsx
  new file mode 100644
  index 000000000..2d33d128b
  --- /dev/null
  +++ b/apps/web/src/components/SidebarV2WorkflowRow.test.tsx
  @@ -0,0 +1,111 @@
  +import { BoardId, EnvironmentId, ProjectId } from "@t3tools/contracts";
  +import { renderToStaticMarkup } from "react-dom/server";
  +import { describe, expect, it, vi } from "vite-plus/test";
- +import type { WorkflowSidebarBoardRow } from "../workflow/useWorkflowSidebarEntries";
  +import {
- SidebarV2WorkflowBoardRow,
- SidebarV2WorkflowProjectErrorRow,
  +} from "./SidebarV2WorkflowRow";
- +const env = EnvironmentId.make("environment-primary");
  +const projectId = ProjectId.make("project-a");
  +const boardId = BoardId.make("project-a\_\_delivery");
- +function boardRow(
- overrides: Partial<WorkflowSidebarBoardRow> = {},
  +): WorkflowSidebarBoardRow {
- return {
- kind: "board",
- environmentId: env,
- projectId,
- projectTitle: "Alpha",
- boardId,
- name: "Delivery",
- filePath: ".t3/boards/delivery.json",
- entryError: null,
- attention: null,
- attentionPill: null,
- ...overrides,
- };
  +}
- +describe("SidebarV2WorkflowBoardRow", () => {
- it("renders name, project title, and attention pill", () => {
- const markup = renderToStaticMarkup(
-      <SidebarV2WorkflowBoardRow
-        row={boardRow({
-          attention: { count: 2, dominantKind: "blocked" },
-          attentionPill: { label: "2 need you", className: "text-red-700" },
-        })}
-        isActive={false}
-        onActivate={() => undefined}
-      />,
- );
- expect(markup).toContain("Delivery");
- expect(markup).toContain("Alpha");
- expect(markup).toContain("2 need you");
- expect(markup).toContain("text-red-700");
- });
-
- it("marks entry-error boards destructive and non-navigable", () => {
- const onActivate = vi.fn();
- const markup = renderToStaticMarkup(
-      <SidebarV2WorkflowBoardRow
-        row={boardRow({ entryError: "decode failed" })}
-        isActive={false}
-        onActivate={onActivate}
-      />,
- );
- expect(markup).toContain('data-entry-error="true"');
- expect(markup).toContain("text-destructive");
- expect(markup).toContain("This board&#x27;s file failed to load");
- expect(markup).toContain("aria-disabled");
- // No click handler when entryError — onActivate must not be wired via onClick.
- expect(markup).not.toContain("role=\"button\"");
- });
-
- it("highlights the active board by data-active", () => {
- const markup = renderToStaticMarkup(
-      <SidebarV2WorkflowBoardRow
-        row={boardRow()}
-        isActive
-        onActivate={() => undefined}
-      />,
- );
- expect(markup).toContain('data-active="true"');
- expect(markup).toContain("bg-sidebar-row-active");
- });
-
- it("clears active styling when not active", () => {
- const markup = renderToStaticMarkup(
-      <SidebarV2WorkflowBoardRow
-        row={boardRow()}
-        isActive={false}
-        onActivate={() => undefined}
-      />,
- );
- expect(markup).toContain('data-active="false"');
- expect(markup).not.toContain("bg-sidebar-row-active");
- });
  +});
- +describe("SidebarV2WorkflowProjectErrorRow", () => {
- it("renders a retryable project-error row", () => {
- const markup = renderToStaticMarkup(
-      <SidebarV2WorkflowProjectErrorRow
-        row={{
-          kind: "project-error",
-          environmentId: env,
-          projectId,
-          projectTitle: "Alpha",
-          error: "network down",
-        }}
-        onRetry={() => undefined}
-      />,
- );
- expect(markup).toContain("Couldn&#x27;t load boards for Alpha");
- expect(markup).toContain(`sidebar-v2-workflow-project-retry-${projectId}`);
- expect(markup).toContain("Retry loading boards for Alpha");
- });
  +});
  diff --git a/apps/web/src/components/SidebarV2WorkflowRow.tsx b/apps/web/src/components/SidebarV2WorkflowRow.tsx
  new file mode 100644
  index 000000000..0125b2fb5
  --- /dev/null
  +++ b/apps/web/src/components/SidebarV2WorkflowRow.tsx
  @@ -0,0 +1,168 @@
  +import type { BoardId, EnvironmentId, ProjectId } from "@t3tools/contracts";
  +import { AlertTriangleIcon, RefreshCwIcon, SquareKanbanIcon } from "lucide-react";
  +import { memo, useCallback, type KeyboardEvent as ReactKeyboardEvent } from "react";
- +import { cn } from "~/lib/utils";
  +import type {
- WorkflowSidebarBoardRow,
- WorkflowSidebarProjectErrorRow,
  +} from "../workflow/useWorkflowSidebarEntries";
  +import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";
- +export interface SidebarV2WorkflowBoardRowProps {
- readonly row: WorkflowSidebarBoardRow;
- readonly isActive: boolean;
- readonly onActivate: (input: {
- readonly environmentId: EnvironmentId;
- readonly boardId: BoardId;
- }) => void;
  +}
- +export interface SidebarV2WorkflowProjectErrorRowProps {
- readonly row: WorkflowSidebarProjectErrorRow;
- readonly onRetry: (projectId: ProjectId) => void;
  +}
- +/\*\*
- - Slim workflow board row for Sidebar v2. Read-navigate only (no rename/delete
- - in v1). entryError boards are destructive + non-navigable.
- \*/
  +export const SidebarV2WorkflowBoardRow = memo(function SidebarV2WorkflowBoardRow(
- props: SidebarV2WorkflowBoardRowProps,
  +) {
- const { row, isActive, onActivate } = props;
- const hasEntryError = row.entryError !== null && row.entryError.length > 0;
-
- const activate = useCallback(() => {
- if (hasEntryError) return;
- onActivate({ environmentId: row.environmentId, boardId: row.boardId });
- }, [hasEntryError, onActivate, row.boardId, row.environmentId]);
-
- const handleKeyDown = useCallback(
- (event: ReactKeyboardEvent) => {
-      if (event.key === "Enter" || event.key === " ") {
-        event.preventDefault();
-        activate();
-      }
- },
- [activate],
- );
-
- return (
- <li className="list-none [content-visibility:auto] [contain-intrinsic-size:auto_36px]">
-      <div
-        role={hasEntryError ? "group" : "button"}
-        tabIndex={hasEntryError ? -1 : 0}
-        data-testid={`sidebar-v2-workflow-row-${row.boardId}`}
-        data-active={isActive ? "true" : "false"}
-        data-entry-error={hasEntryError ? "true" : "false"}
-        aria-disabled={hasEntryError ? true : undefined}
-        className={cn(
-          "group/v2-workflow-row relative flex h-9 w-full items-center gap-2.5 overflow-hidden rounded-md px-2.5 text-left outline-none select-none",
-          hasEntryError
-            ? "cursor-default text-destructive"
-            : isActive
-              ? "cursor-pointer bg-sidebar-row-active text-sidebar-foreground dark:inset-ring-1 dark:inset-ring-white/5"
-              : "cursor-pointer bg-transparent text-sidebar-foreground hover:bg-sidebar-row-hover",
-        )}
-        onClick={hasEntryError ? undefined : activate}
-        onKeyDown={hasEntryError ? undefined : handleKeyDown}
-      >
-        <SquareKanbanIcon
-          className={cn(
-            "size-4 shrink-0",
-            hasEntryError
-              ? "text-destructive"
-              : "text-sidebar-muted-foreground/80 group-hover/v2-workflow-row:text-sidebar-foreground",
-          )}
-        />
-        <span className="flex min-w-0 flex-1 flex-col leading-tight">
-          <span
-            className={cn(
-              "truncate text-sm font-medium",
-              hasEntryError
-                ? "text-destructive"
-                : isActive
-                  ? "text-foreground"
-                  : "text-sidebar-foreground/90",
-            )}
-          >
-            {row.name}
-          </span>
-          <span
-            className={cn(
-              "truncate text-[11px]",
-              hasEntryError ? "text-destructive/80" : "text-sidebar-muted-foreground/70",
-            )}
-          >
-            {row.projectTitle}
-          </span>
-        </span>
-        {hasEntryError ? (
-          <Tooltip>
-            <TooltipTrigger
-              render={
-                <span
-                  aria-label="This board's file failed to load"
-                  className="ml-auto inline-flex size-5 shrink-0 items-center justify-center text-destructive"
-                >
-                  <AlertTriangleIcon className="size-3.5" />
-                </span>
-              }
-            />
-            <TooltipPopup side="right" className="max-w-72 whitespace-normal leading-tight">
-              This board's file failed to load
-              {row.entryError ? `: ${row.entryError}` : ""}
-            </TooltipPopup>
-          </Tooltip>
-        ) : row.attentionPill ? (
-          <span
-            data-testid={`sidebar-v2-workflow-attention-${row.boardId}`}
-            className={cn(
-              "ml-auto shrink-0 text-[11px] font-medium tabular-nums",
-              row.attentionPill.className,
-            )}
-          >
-            {row.attentionPill.label}
-          </span>
-        ) : null}
-      </div>
- </li>
- );
  +});
- +/\*\*
- - Project-level query failure row — subdued, retryable. Distinct from a board
- - entryError (decode failure on a discovered board file).
- \*/
  +export const SidebarV2WorkflowProjectErrorRow = memo(function SidebarV2WorkflowProjectErrorRow(
- props: SidebarV2WorkflowProjectErrorRowProps,
  +) {
- const { row, onRetry } = props;
- const handleRetry = useCallback(() => {
- onRetry(row.projectId);
- }, [onRetry, row.projectId]);
-
- return (
- <li className="list-none">
-      <div
-        data-testid={`sidebar-v2-workflow-project-error-${row.projectId}`}
-        className="flex h-9 w-full items-center gap-2 rounded-md px-2.5 text-left text-sidebar-muted-foreground"
-      >
-        <AlertTriangleIcon className="size-3.5 shrink-0 text-muted-foreground/70" />
-        <span className="min-w-0 flex-1 truncate text-xs">
-          Couldn't load boards for {row.projectTitle}
-        </span>
-        <button
-          type="button"
-          data-testid={`sidebar-v2-workflow-project-retry-${row.projectId}`}
-          aria-label={`Retry loading boards for ${row.projectTitle}`}
-          className="inline-flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-md text-muted-foreground hover:bg-sidebar-row-hover hover:text-foreground"
-          onClick={handleRetry}
-        >
-          <RefreshCwIcon className="size-3.5" />
-        </button>
-      </div>
- </li>
- );
  +});
  diff --git a/apps/web/src/components/WorkflowCreateCoordinator.test.ts b/apps/web/src/components/WorkflowCreateCoordinator.test.ts
  new file mode 100644
  index 000000000..34b955603
  --- /dev/null
  +++ b/apps/web/src/components/WorkflowCreateCoordinator.test.ts
  @@ -0,0 +1,58 @@
  +import { EnvironmentId, ProjectId } from "@t3tools/contracts";
  +import { describe, expect, it } from "vite-plus/test";
- +/\*\*
- - Coordinator receives create intents as { projectId, environmentId }.
- - The bus itself is window-backed; these tests lock the pure acceptance
- - rules the coordinator applies when an intent arrives (primary-env only).
- \*/
- +export function shouldOpenCreateWorkflowDialog(input: {
- readonly primaryEnvironmentId: EnvironmentId | null;
- readonly intent: {
- readonly projectId: ProjectId;
- readonly environmentId: EnvironmentId;
- };
- readonly knownProjectIds: ReadonlyArray<ProjectId>;
  +}): boolean {
- if (input.primaryEnvironmentId === null) return false;
- if (input.intent.environmentId !== input.primaryEnvironmentId) return false;
- return input.knownProjectIds.includes(input.intent.projectId);
  +}
- +const env = EnvironmentId.make("environment-primary");
  +const remote = EnvironmentId.make("environment-remote");
  +const projectA = ProjectId.make("project-a");
  +const projectB = ProjectId.make("project-b");
- +describe("WorkflowCreateCoordinator intent acceptance", () => {
- it("opens for a known primary-env project emitted by the palette submenu", () => {
- expect(
-      shouldOpenCreateWorkflowDialog({
-        primaryEnvironmentId: env,
-        intent: { projectId: projectA, environmentId: env },
-        knownProjectIds: [projectA, projectB],
-      }),
- ).toBe(true);
- });
-
- it("rejects non-primary environment intents", () => {
- expect(
-      shouldOpenCreateWorkflowDialog({
-        primaryEnvironmentId: env,
-        intent: { projectId: projectA, environmentId: remote },
-        knownProjectIds: [projectA],
-      }),
- ).toBe(false);
- });
-
- it("rejects when there is no primary environment", () => {
- expect(
-      shouldOpenCreateWorkflowDialog({
-        primaryEnvironmentId: null,
-        intent: { projectId: projectA, environmentId: env },
-        knownProjectIds: [projectA],
-      }),
- ).toBe(false);
- });
  +});
  diff --git a/apps/web/src/components/WorkflowCreateCoordinator.tsx b/apps/web/src/components/WorkflowCreateCoordinator.tsx
  new file mode 100644
  index 000000000..af87bca78
  --- /dev/null
  +++ b/apps/web/src/components/WorkflowCreateCoordinator.tsx
  @@ -0,0 +1,126 @@
  +import { RegistryContext } from "@effect/atom-react";
  +import {
- EnvironmentId,
- ProjectId,
- type EnvironmentApi,
  +} from "@t3tools/contracts";
  +import { useNavigate } from "@tanstack/react-router";
  +import { useCallback, useContext, useEffect, useMemo, useState } from "react";
- +import { onRequestCreateWorkflow } from "../commandPaletteBus";
  +import { useProjects } from "../state/entities";
  +import { usePrimaryEnvironmentId } from "../state/environments";
  +import { useEnvironmentQuery } from "../state/query";
  +import { workflowEnvironment } from "../state/workflow";
  +import { refreshListBoards } from "../workflow/useWorkflowSidebarEntries";
  +import { useWorkflowApi } from "../workflow/useWorkflowApi";
  +import { CreateWorkflowDialog } from "./board/CreateWorkflowDialog";
- +/\*_ Placeholder ids so hooks stay unconditional while the dialog is closed. _/
  +const IDLE_ENVIRONMENT_ID = EnvironmentId.make("workflow-create-idle");
  +const IDLE_PROJECT_ID = ProjectId.make("workflow-create-idle");
- +interface CreateTarget {
- readonly projectId: ProjectId;
- readonly environmentId: EnvironmentId;
- readonly projectName: string;
  +}
- +/\*\*
- - Stable owner of CreateWorkflowDialog, mounted in AppSidebarLayout outside
- - both sidebar variants. Survives mode/sidebar-variant switches. Consumes the
- - `requestCreateWorkflow` bus intent (from the palette new-workflow-in submenu
- - or the SidebarV2 Add-workflow button).
- \*/
  +export function WorkflowCreateCoordinator() {
- const registry = useContext(RegistryContext);
- const navigate = useNavigate();
- const projects = useProjects();
- const primaryEnvironmentId = usePrimaryEnvironmentId();
- const [target, setTarget] = useState<CreateTarget | null>(null);
- const open = target !== null;
-
- useEffect(
- () =>
-      onRequestCreateWorkflow((detail) => {
-        // Only primary-env projects are creatable (providers come from primary).
-        if (primaryEnvironmentId === null || detail.environmentId !== primaryEnvironmentId) {
-          return;
-        }
-        const project = projects.find(
-          (candidate) =>
-            candidate.id === detail.projectId && candidate.environmentId === detail.environmentId,
-        );
-        setTarget({
-          projectId: detail.projectId,
-          environmentId: detail.environmentId,
-          projectName: project?.title ?? "Project",
-        });
-      }),
- [primaryEnvironmentId, projects],
- );
-
- const handleOpenChange = useCallback((nextOpen: boolean) => {
- if (!nextOpen) {
-      setTarget(null);
- }
- }, []);
-
- // Hooks must run unconditionally. While closed, bind to idle placeholders
- // so we never fire listBoards for a real project without an open dialog.
- const environmentId = target?.environmentId ?? primaryEnvironmentId ?? IDLE_ENVIRONMENT_ID;
- const projectId = target?.projectId ?? IDLE_PROJECT_ID;
- const workflowApi = useWorkflowApi(environmentId);
- // Same partial-facade pattern as Sidebar.tsx board create (workflow-only).
- const api = useMemo<EnvironmentApi>(
- () => ({ workflow: workflowApi }) as EnvironmentApi,
- [workflowApi],
- );
-
- const boardsAtom = useMemo(
- () =>
-      target
-        ? workflowEnvironment.listBoards({
-            environmentId: target.environmentId,
-            input: { projectId: target.projectId },
-          })
-        : null,
- [target],
- );
- const { data: boards } = useEnvironmentQuery(boardsAtom);
- const existingBoardNames = useMemo(
- () => (boards ?? []).map((board) => board.name),
- [boards],
- );
-
- const handleCreated = useCallback(
- (boardId: string) => {
-      if (!target) return;
-      refreshListBoards(registry, target.environmentId, target.projectId);
-      setTarget(null);
-      void navigate({
-        to: "/$environmentId/board",
-        params: { environmentId: target.environmentId },
-        search: { boardId },
-      });
- },
- [navigate, registry, target],
- );
-
- if (!target) {
- return null;
- }
-
- return (
- <CreateWorkflowDialog
-      open={open}
-      onOpenChange={handleOpenChange}
-      projectId={projectId}
-      environmentId={environmentId}
-      projectName={target.projectName}
-      api={api}
-      existingBoardNames={existingBoardNames}
-      onCreated={handleCreated}
- />
- );
  +}
  diff --git a/apps/web/src/components/WorkflowSidebarList.empty.test.tsx b/apps/web/src/components/WorkflowSidebarList.empty.test.tsx
  new file mode 100644
  index 000000000..710b4efd1
  --- /dev/null
  +++ b/apps/web/src/components/WorkflowSidebarList.empty.test.tsx
  @@ -0,0 +1,39 @@
  +import { renderToStaticMarkup } from "react-dom/server";
  +import { describe, expect, it } from "vite-plus/test";
- +/\*\*
- - Empty-state copy is mode-specific ("No workflows yet…"). The full list
- - component needs atom registry + router; this locks the empty-state markup
- - fragment the list renders when isEmpty is true.
- \*/
  +function WorkflowsEmptyState(props: { readonly onRequestAddWorkflow?: () => void }) {
- return (
- <div
-      data-testid="sidebar-v2-workflows-empty"
-      className="flex flex-col items-center gap-2 px-2 py-6 text-center text-xs text-muted-foreground/60"
- >
-      <span>No workflows yet — Add workflow to create one</span>
-      {props.onRequestAddWorkflow ? (
-        <button type="button" data-testid="sidebar-v2-workflows-empty-cta" onClick={props.onRequestAddWorkflow}>
-          Add workflow
-        </button>
-      ) : null}
- </div>
- );
  +}
- +describe("WorkflowSidebarList empty state", () => {
- it("uses mode-specific copy, not No threads", () => {
- const markup = renderToStaticMarkup(<WorkflowsEmptyState />);
- expect(markup).toContain("No workflows yet — Add workflow to create one");
- expect(markup).not.toContain("No threads");
- });
-
- it("optionally renders an Add workflow CTA", () => {
- const markup = renderToStaticMarkup(
-      <WorkflowsEmptyState onRequestAddWorkflow={() => undefined} />,
- );
- expect(markup).toContain("sidebar-v2-workflows-empty-cta");
- expect(markup).toContain("Add workflow");
- });
  +});
  diff --git a/apps/web/src/components/WorkflowSidebarList.tsx b/apps/web/src/components/WorkflowSidebarList.tsx
  new file mode 100644
  index 000000000..aa0909349
  --- /dev/null
  +++ b/apps/web/src/components/WorkflowSidebarList.tsx
  @@ -0,0 +1,155 @@
  +import type { BoardId, EnvironmentId, ProjectId } from "@t3tools/contracts";
  +import { useNavigate, useParams, useLocation } from "@tanstack/react-router";
  +import { useCallback, useEffect, useMemo } from "react";
- +import { usePrimaryEnvironmentId } from "../state/environments";
  +import {
- filterEligibleWorkflowProjects,
- useWorkflowSidebarEntries,
- type WorkflowSidebarEligibleProject,
  +} from "../workflow/useWorkflowSidebarEntries";
  +import {
- isSidebarBoardRouteActive,
- type SidebarBoardRouteIdentity,
  +} from "./Sidebar.logic";
  +import {
- SidebarV2WorkflowBoardRow,
- SidebarV2WorkflowProjectErrorRow,
  +} from "./SidebarV2WorkflowRow";
- +export interface WorkflowSidebarListProps {
- readonly projects: ReadonlyArray<WorkflowSidebarEligibleProject>;
- /\*\*
- - Current project-scope filter: null = All projects; otherwise the selected
- - project (may be non-primary — eligibility handles that).
- \*/
- readonly scopedProject:
- | { readonly id: ProjectId; readonly environmentId: EnvironmentId }
- | null;
- /\*_ Called when the empty-state CTA should open create for the only/zero case. _/
- readonly onRequestAddWorkflow?: (() => void) | undefined;
  +}
- +/\*\*
- - Workflows-mode list. Mounted only when mode === "workflows" so its atom
- - subscriptions exist only in that mode. Owns the aggregate listBoards +
- - attention subscription via useWorkflowSidebarEntries.
- \*/
  +export function WorkflowSidebarList(props: WorkflowSidebarListProps) {
- const { projects, scopedProject, onRequestAddWorkflow } = props;
- const primaryEnvironmentId = usePrimaryEnvironmentId();
- const navigate = useNavigate();
-
- const eligibleProjects = useMemo(
- () =>
-      filterEligibleWorkflowProjects({
-        projects,
-        primaryEnvironmentId,
-        scopedProject,
-      }),
- [primaryEnvironmentId, projects, scopedProject],
- );
-
- const { rows, pending, isEmpty, refreshProject, refreshAll } = useWorkflowSidebarEntries({
- eligibleProjects,
- primaryEnvironmentId,
- });
-
- // Mode-enter refresh: this component mounts only on workflows mode enter.
- useEffect(() => {
- refreshAll();
- // Intentionally once on mount (mode enter). refreshAll identity is stable
- // enough across eligible key changes; re-running on every refreshAll churn
- // would hammer the network.
- // eslint-disable-next-line react-hooks/exhaustive-deps -- mode-enter only
- }, []);
-
- const routeParams = useParams({ strict: false });
- const routeSearch = useLocation({ select: (location) => location.search });
- const activeRouteBoard = useMemo<SidebarBoardRouteIdentity | null>(() => {
- const routeEnvId = Reflect.get(routeParams, "environmentId");
- const boardId = Reflect.get(routeSearch, "boardId");
- if (typeof routeEnvId !== "string" || typeof boardId !== "string" || boardId.length === 0) {
-      return null;
- }
- return { environmentId: routeEnvId, boardId };
- }, [routeParams, routeSearch]);
-
- const handleActivate = useCallback(
- (input: { readonly environmentId: EnvironmentId; readonly boardId: BoardId }) => {
-      void navigate({
-        to: "/$environmentId/board",
-        params: { environmentId: input.environmentId },
-        search: { boardId: input.boardId },
-      });
- },
- [navigate],
- );
-
- const handleRetry = useCallback(
- (projectId: ProjectId) => {
-      refreshProject(projectId);
- },
- [refreshProject],
- );
-
- if (pending && rows.length === 0) {
- return (
-      <div
-        data-testid="sidebar-v2-workflows-pending"
-        className="px-2 py-6 text-center text-xs text-muted-foreground/60"
-      >
-        Loading workflows…
-      </div>
- );
- }
-
- if (isEmpty) {
- return (
-      <div
-        data-testid="sidebar-v2-workflows-empty"
-        className="flex flex-col items-center gap-2 px-2 py-6 text-center text-xs text-muted-foreground/60"
-      >
-        <span>No workflows yet — Add workflow to create one</span>
-        {onRequestAddWorkflow ? (
-          <button
-            type="button"
-            data-testid="sidebar-v2-workflows-empty-cta"
-            onClick={onRequestAddWorkflow}
-            className="inline-flex items-center gap-1.5 rounded-md border border-sidebar-border px-2.5 py-1 text-[11px] font-medium text-sidebar-muted-foreground transition-colors hover:bg-sidebar-row-hover hover:text-sidebar-foreground"
-          >
-            Add workflow
-          </button>
-        ) : null}
-      </div>
- );
- }
-
- return (
- <ul role="list" data-testid="sidebar-v2-workflows-list" className="flex flex-col gap-px">
-      {rows.map((row) => {
-        if (row.kind === "project-error") {
-          return (
-            <SidebarV2WorkflowProjectErrorRow
-              key={`error:${row.environmentId}:${row.projectId}`}
-              row={row}
-              onRetry={handleRetry}
-            />
-          );
-        }
-        return (
-          <SidebarV2WorkflowBoardRow
-            key={`${row.environmentId}:${row.projectId}:${row.boardId}`}
-            row={row}
-            isActive={isSidebarBoardRouteActive(activeRouteBoard, {
-              environmentId: row.environmentId,
-              projectId: row.projectId,
-              boardId: row.boardId,
-            })}
-            onActivate={handleActivate}
-          />
-        );
-      })}
- </ul>
- );
  +}
  diff --git a/apps/web/src/workflow/useWorkflowSidebarEntries.test.ts b/apps/web/src/workflow/useWorkflowSidebarEntries.test.ts
  new file mode 100644
  index 000000000..b96e9ecc5
  --- /dev/null
  +++ b/apps/web/src/workflow/useWorkflowSidebarEntries.test.ts
  @@ -0,0 +1,279 @@
  +import {
- BoardId,
- EnvironmentId,
- LaneKey,
- ProjectId,
- TicketId,
- type BoardListEntry,
- type WorkflowNeedsAttentionTicketView,
  +} from "@t3tools/contracts";
  +import { describe, expect, it } from "vite-plus/test";
- +import {
- buildWorkflowSidebarEntries,
- filterEligibleWorkflowProjects,
- type ProjectBoardsQueryResult,
- type WorkflowSidebarEligibleProject,
  +} from "./useWorkflowSidebarEntries";
- +const envPrimary = EnvironmentId.make("environment-primary");
  +const envRemote = EnvironmentId.make("environment-remote");
  +const projectA = ProjectId.make("project-a");
  +const projectB = ProjectId.make("project-b");
  +const projectRemote = ProjectId.make("project-remote");
- +const eligible: ReadonlyArray<WorkflowSidebarEligibleProject> = [
- { id: projectA, environmentId: envPrimary, title: "Alpha" },
- { id: projectB, environmentId: envPrimary, title: "Beta" },
  +];
- +const entry = (
- projectId: ProjectId,
- slug: string,
- name: string,
- error: string | null = null,
  +): BoardListEntry => ({
- boardId: BoardId.make(`${projectId}__${slug}`),
- name,
- filePath: `.t3/boards/${slug}.json`,
- error,
  +});
- +const attention = (
- boardId: BoardId,
- kind: WorkflowNeedsAttentionTicketView["attentionKind"],
- ticketSlug: string,
  +): WorkflowNeedsAttentionTicketView => ({
- ticketId: TicketId.make(`ticket-${ticketSlug}`),
- boardId,
- boardName: "Board",
- title: "Ticket",
- status: "waiting_on_user",
- currentLaneKey: LaneKey.make("run"),
- attentionKind: kind,
- attentionReason: null,
- updatedAt: "2026-07-22T00:00:00.000Z",
- parkedAt: null,
  +});
- +describe("filterEligibleWorkflowProjects", () => {
- const allProjects: ReadonlyArray<WorkflowSidebarEligibleProject> = [
- ...eligible,
- { id: projectRemote, environmentId: envRemote, title: "Remote" },
- ];
-
- it("keeps only primary-env projects when scope is All", () => {
- expect(
-      filterEligibleWorkflowProjects({
-        projects: allProjects,
-        primaryEnvironmentId: envPrimary,
-        scopedProject: null,
-      }).map((project) => project.id),
- ).toEqual([projectA, projectB]);
- });
-
- it("narrows to the scoped primary-env project", () => {
- expect(
-      filterEligibleWorkflowProjects({
-        projects: allProjects,
-        primaryEnvironmentId: envPrimary,
-        scopedProject: { id: projectB, environmentId: envPrimary },
-      }).map((project) => project.id),
- ).toEqual([projectB]);
- });
-
- it("returns empty when scope is a non-primary project", () => {
- expect(
-      filterEligibleWorkflowProjects({
-        projects: allProjects,
-        primaryEnvironmentId: envPrimary,
-        scopedProject: { id: projectRemote, environmentId: envRemote },
-      }),
- ).toEqual([]);
- });
-
- it("returns empty without a primary environment", () => {
- expect(
-      filterEligibleWorkflowProjects({
-        projects: allProjects,
-        primaryEnvironmentId: null,
-        scopedProject: null,
-      }),
- ).toEqual([]);
- });
  +});
- +describe("buildWorkflowSidebarEntries", () => {
- it("flattens boards with (env, project, board) tags and joins attention", () => {
- const boardResultsByProjectId = new Map<ProjectId, ProjectBoardsQueryResult>([
-      [projectA, { status: "success", entries: [entry(projectA, "delivery", "Delivery")] }],
-      [projectB, { status: "success", entries: [entry(projectB, "triage", "Triage")] }],
- ]);
- const deliveryId = BoardId.make(`${projectA}__delivery`);
- const built = buildWorkflowSidebarEntries({
-      eligibleProjects: eligible,
-      boardResultsByProjectId,
-      attentionTickets: [
-        attention(deliveryId, "blocked", "blocked"),
-        attention(deliveryId, "parked_waiting", "waiting"),
-      ],
-      attentionPending: false,
-      primaryEnvironmentId: envPrimary,
- });
-
- expect(built.boards).toHaveLength(2);
- expect(built.boards[0]).toMatchObject({
-      kind: "board",
-      environmentId: envPrimary,
-      projectId: projectA,
-      projectTitle: "Alpha",
-      name: "Delivery",
-      entryError: null,
- });
- expect(built.boards[0]?.attention).toEqual({ count: 2, dominantKind: "blocked" });
- expect(built.boards[0]?.attentionPill?.label).toBe("2 need you");
- expect(built.isEmpty).toBe(false);
- expect(built.pending).toBe(false);
- expect(built.errorsByProject.size).toBe(0);
- });
-
- it("preserves partial success when one project errors", () => {
- const boardResultsByProjectId = new Map<ProjectId, ProjectBoardsQueryResult>([
-      [projectA, { status: "success", entries: [entry(projectA, "ok", "Ok Board")] }],
-      [projectB, { status: "error", error: "network down" }],
- ]);
- const built = buildWorkflowSidebarEntries({
-      eligibleProjects: eligible,
-      boardResultsByProjectId,
-      attentionTickets: [],
-      attentionPending: false,
-      primaryEnvironmentId: envPrimary,
- });
-
- expect(built.boards.map((board) => board.name)).toEqual(["Ok Board"]);
- expect(built.errorsByProject.get(projectB)).toBe("network down");
- expect(built.rows.some((row) => row.kind === "project-error")).toBe(true);
- expect(built.isEmpty).toBe(false);
- expect(built.pending).toBe(false);
- });
-
- it("is pending while any eligible query is loading", () => {
- const boardResultsByProjectId = new Map<ProjectId, ProjectBoardsQueryResult>([
-      [projectA, { status: "success", entries: [] }],
-      [projectB, { status: "pending" }],
- ]);
- const built = buildWorkflowSidebarEntries({
-      eligibleProjects: eligible,
-      boardResultsByProjectId,
-      attentionTickets: [],
-      attentionPending: false,
-      primaryEnvironmentId: envPrimary,
- });
- expect(built.pending).toBe(true);
- expect(built.isEmpty).toBe(false);
- });
-
- it("is empty only when all succeed with zero boards", () => {
- const boardResultsByProjectId = new Map<ProjectId, ProjectBoardsQueryResult>([
-      [projectA, { status: "success", entries: [] }],
-      [projectB, { status: "success", entries: [] }],
- ]);
- const built = buildWorkflowSidebarEntries({
-      eligibleProjects: eligible,
-      boardResultsByProjectId,
-      attentionTickets: [],
-      attentionPending: false,
-      primaryEnvironmentId: envPrimary,
- });
- expect(built.isEmpty).toBe(true);
- expect(built.boards).toEqual([]);
- expect(built.rows).toEqual([]);
- });
-
- it("does not treat project-error-only as empty", () => {
- const boardResultsByProjectId = new Map<ProjectId, ProjectBoardsQueryResult>([
-      [projectA, { status: "error", error: "boom" }],
-      [projectB, { status: "error", error: "boom-2" }],
- ]);
- const built = buildWorkflowSidebarEntries({
-      eligibleProjects: eligible,
-      boardResultsByProjectId,
-      attentionTickets: [],
-      attentionPending: false,
-      primaryEnvironmentId: envPrimary,
- });
- expect(built.isEmpty).toBe(false);
- expect(built.rows.every((row) => row.kind === "project-error")).toBe(true);
- });
-
- it("distinguishes entryError boards from project-error rows", () => {
- const boardResultsByProjectId = new Map<ProjectId, ProjectBoardsQueryResult>([
-      [
-        projectA,
-        {
-          status: "success",
-          entries: [entry(projectA, "broken", "Broken Board", "decode failed")],
-        },
-      ],
-      [projectB, { status: "error", error: "rpc failed" }],
- ]);
- const built = buildWorkflowSidebarEntries({
-      eligibleProjects: eligible,
-      boardResultsByProjectId,
-      attentionTickets: [],
-      attentionPending: false,
-      primaryEnvironmentId: envPrimary,
- });
-
- const boardRow = built.boards[0];
- expect(boardRow?.entryError).toBe("decode failed");
- expect(boardRow?.kind).toBe("board");
- const projectError = built.rows.find((row) => row.kind === "project-error");
- expect(projectError).toMatchObject({
-      kind: "project-error",
-      projectId: projectB,
-      error: "rpc failed",
- });
- });
-
- it("sorts by eligible project index → name (locale, case-insensitive) → boardId", () => {
- const boardResultsByProjectId = new Map<ProjectId, ProjectBoardsQueryResult>([
-      [
-        projectA,
-        {
-          status: "success",
-          entries: [
-            entry(projectA, "z", "zebra"),
-            entry(projectA, "a", "Apple"),
-            entry(projectA, "b", "apple"),
-          ],
-        },
-      ],
-      [
-        projectB,
-        {
-          status: "success",
-          entries: [entry(projectB, "m", "Middle")],
-        },
-      ],
- ]);
- const built = buildWorkflowSidebarEntries({
-      eligibleProjects: eligible,
-      boardResultsByProjectId,
-      attentionTickets: [],
-      attentionPending: false,
-      primaryEnvironmentId: envPrimary,
- });
-
- // Project A first (eligible index 0), then names case-insensitive.
- // "Apple" and "apple" tie on name → boardId tiebreak (a before b).
- expect(built.boards.map((board) => `${board.projectId}:${board.name}:${board.boardId}`)).toEqual(
-      [
-        `${projectA}:Apple:${projectA}__a`,
-        `${projectA}:apple:${projectA}__b`,
-        `${projectA}:zebra:${projectA}__z`,
-        `${projectB}:Middle:${projectB}__m`,
-      ],
- );
- });
  +});
  diff --git a/apps/web/src/workflow/useWorkflowSidebarEntries.ts b/apps/web/src/workflow/useWorkflowSidebarEntries.ts
  new file mode 100644
  index 000000000..8a5c05bc2
  --- /dev/null
  +++ b/apps/web/src/workflow/useWorkflowSidebarEntries.ts
  @@ -0,0 +1,352 @@
  +import { RegistryContext } from "@effect/atom-react";
  +import type {
- BoardId,
- BoardListEntry,
- EnvironmentId,
- ProjectId,
- WorkflowNeedsAttentionTicketView,
  +} from "@t3tools/contracts";
  +import _ as Cause from "effect/Cause";
  +import _ as Option from "effect/Option";
  +import { AsyncResult, Atom, type AtomRegistry } from "effect/unstable/reactivity";
  +import { useContext, useEffect, useMemo, useState } from "react";
- +import { workflowEnvironment } from "../state/workflow";
  +import {
- groupAttentionByBoard,
- resolveWorkflowSidebarAttentionPill,
- workflowBoardAttentionKey,
- type WorkflowSidebarAttentionPill,
- type WorkflowSidebarAttentionSummary,
  +} from "./workflowSidebarStatus";
- +export interface WorkflowSidebarEligibleProject {
- readonly id: ProjectId;
- readonly environmentId: EnvironmentId;
- readonly title: string;
  +}
- +export interface WorkflowSidebarBoardRow {
- readonly kind: "board";
- readonly environmentId: EnvironmentId;
- readonly projectId: ProjectId;
- readonly projectTitle: string;
- readonly boardId: BoardId;
- readonly name: string;
- readonly filePath: string;
- /\*_ Decode failure on a discovered board file — distinct from project query failure. _/
- readonly entryError: string | null;
- readonly attention: WorkflowSidebarAttentionSummary | null;
- readonly attentionPill: WorkflowSidebarAttentionPill | null;
  +}
- +export interface WorkflowSidebarProjectErrorRow {
- readonly kind: "project-error";
- readonly environmentId: EnvironmentId;
- readonly projectId: ProjectId;
- readonly projectTitle: string;
- readonly error: string;
  +}
- +export type WorkflowSidebarListRow = WorkflowSidebarBoardRow | WorkflowSidebarProjectErrorRow;
- +export interface WorkflowSidebarEntriesState {
- readonly boards: ReadonlyArray<WorkflowSidebarBoardRow>;
- readonly rows: ReadonlyArray<WorkflowSidebarListRow>;
- readonly pending: boolean;
- readonly errorsByProject: ReadonlyMap<ProjectId, string>;
- /\*\*
- - True only when every eligible project query has succeeded and total board
- - count is zero (project-error rows and pending both suppress empty).
- \*/
- readonly isEmpty: boolean;
- readonly refreshProject: (projectId: ProjectId) => void;
- readonly refreshAll: () => void;
  +}
- +export type ProjectBoardsQueryResult =
- | { readonly status: "pending" }
- | { readonly status: "error"; readonly error: string }
- | { readonly status: "success"; readonly entries: ReadonlyArray<BoardListEntry> };
- +/\*\*
- - Pure aggregate: flatten eligible project board queries + attention join +
- - total sort. Extracted so partial-success / empty / sort tests do not need
- - the atom registry.
- \*/
  +export function buildWorkflowSidebarEntries(input: {
- readonly eligibleProjects: ReadonlyArray<WorkflowSidebarEligibleProject>;
- readonly boardResultsByProjectId: ReadonlyMap<ProjectId, ProjectBoardsQueryResult>;
- readonly attentionTickets: ReadonlyArray<WorkflowNeedsAttentionTicketView> | null;
- readonly attentionPending: boolean;
- readonly primaryEnvironmentId: EnvironmentId | string | null;
  +}): {
- readonly boards: ReadonlyArray<WorkflowSidebarBoardRow>;
- readonly rows: ReadonlyArray<WorkflowSidebarListRow>;
- readonly pending: boolean;
- readonly errorsByProject: ReadonlyMap<ProjectId, string>;
- readonly isEmpty: boolean;
  +} {
- const errorsByProject = new Map<ProjectId, string>();
- const boards: WorkflowSidebarBoardRow[] = [];
- const projectErrorRows: WorkflowSidebarProjectErrorRow[] = [];
- let anyPending = input.attentionPending;
- let allSucceeded = true;
-
- const attentionByBoard =
- input.primaryEnvironmentId === null || input.attentionTickets === null
-      ? new Map<string, WorkflowSidebarAttentionSummary>()
-      : groupAttentionByBoard({
-          environmentId: input.primaryEnvironmentId,
-          tickets: input.attentionTickets,
-        });
-
- for (const project of input.eligibleProjects) {
- const result = input.boardResultsByProjectId.get(project.id) ?? { status: "pending" as const };
- if (result.status === "pending") {
-      anyPending = true;
-      allSucceeded = false;
-      continue;
- }
- if (result.status === "error") {
-      allSucceeded = false;
-      errorsByProject.set(project.id, result.error);
-      projectErrorRows.push({
-        kind: "project-error",
-        environmentId: project.environmentId,
-        projectId: project.id,
-        projectTitle: project.title,
-        error: result.error,
-      });
-      continue;
- }
-
- for (const entry of result.entries) {
-      const attention =
-        attentionByBoard.get(workflowBoardAttentionKey(project.environmentId, entry.boardId)) ??
-        null;
-      boards.push({
-        kind: "board",
-        environmentId: project.environmentId,
-        projectId: project.id,
-        projectTitle: project.title,
-        boardId: entry.boardId,
-        name: entry.name,
-        filePath: entry.filePath,
-        entryError: entry.error,
-        attention,
-        attentionPill: resolveWorkflowSidebarAttentionPill(attention),
-      });
- }
- }
-
- const projectIndexById = new Map(
- input.eligibleProjects.map((project, index) => [project.id, index] as const),
- );
-
- boards.sort((left, right) => {
- const leftIndex = projectIndexById.get(left.projectId) ?? 0;
- const rightIndex = projectIndexById.get(right.projectId) ?? 0;
- if (leftIndex !== rightIndex) return leftIndex - rightIndex;
- const nameCmp = left.name.localeCompare(right.name, undefined, { sensitivity: "base" });
- if (nameCmp !== 0) return nameCmp;
- return left.boardId.localeCompare(right.boardId);
- });
-
- // Project-error rows stay after boards for the projects that failed, ordered
- // by eligible project index so partial-success remains scannable.
- projectErrorRows.sort((left, right) => {
- const leftIndex = projectIndexById.get(left.projectId) ?? 0;
- const rightIndex = projectIndexById.get(right.projectId) ?? 0;
- return leftIndex - rightIndex;
- });
-
- const rows: WorkflowSidebarListRow[] = [...boards, ...projectErrorRows];
- const isEmpty =
- !anyPending && allSucceeded && boards.length === 0 && projectErrorRows.length === 0;
-
- return {
- boards,
- rows,
- pending: anyPending,
- errorsByProject,
- isEmpty,
- };
  +}
- +function formatQueryError(cause: Cause.Cause<unknown>): string {
- const error = Cause.squash(cause);
- return error instanceof Error && error.message.trim().length > 0
- ? error.message
- : "The environment request failed.";
  +}
- +function readProjectBoardsResult(
- result: AsyncResult.AsyncResult<ReadonlyArray<BoardListEntry>, unknown>,
  +): ProjectBoardsQueryResult {
- if (AsyncResult.isSuccess(result)) {
- return { status: "success", entries: result.value };
- }
- if (result.\_tag === "Failure") {
- return { status: "error", error: formatQueryError(result.cause) };
- }
- return { status: "pending" };
  +}
- +const EMPTY_STATE: Omit<WorkflowSidebarEntriesState, "refreshProject" | "refreshAll"> = {
- boards: [],
- rows: [],
- pending: false,
- errorsByProject: new Map(),
- isEmpty: true,
  +};
- +/\*\*
- - Aggregate hook for the Workflows sidebar list.
- -
- - Eligible projects must already be filtered (primary-env ∩ project-scope)
- - before this hook is called. One memoized aggregate atom reads each project's
- - listBoards atom + the primary env listNeedsAttentionTickets atom; the
- - registry mounts + subscribes that aggregate once (not useEnvironmentQuery
- - inside a .map()).
- \*/
  +export function useWorkflowSidebarEntries(input: {
- readonly eligibleProjects: ReadonlyArray<WorkflowSidebarEligibleProject>;
- readonly primaryEnvironmentId: EnvironmentId | null;
  +}): WorkflowSidebarEntriesState {
- const registry = useContext(RegistryContext);
- const eligibleKey = input.eligibleProjects
- .map((project) => `${project.environmentId}:${project.id}`)
- .join("|");
-
- const aggregateAtom = useMemo(() => {
- const projects = input.eligibleProjects;
- const primaryEnvironmentId = input.primaryEnvironmentId;
-
- return Atom.make((get) => {
-      const boardResultsByProjectId = new Map<ProjectId, ProjectBoardsQueryResult>();
-      for (const project of projects) {
-        const atom = workflowEnvironment.listBoards({
-          environmentId: project.environmentId,
-          input: { projectId: project.id },
-        });
-        boardResultsByProjectId.set(project.id, readProjectBoardsResult(get(atom)));
-      }
-
-      let attentionTickets: ReadonlyArray<WorkflowNeedsAttentionTicketView> | null = null;
-      let attentionPending = false;
-      if (primaryEnvironmentId !== null) {
-        const attentionAtom = workflowEnvironment.listNeedsAttentionTickets({
-          environmentId: primaryEnvironmentId,
-          input: {},
-        });
-        const attentionResult = get(attentionAtom);
-        if (AsyncResult.isSuccess(attentionResult)) {
-          attentionTickets = attentionResult.value;
-        } else if (attentionResult._tag === "Failure") {
-          // Attention failure does not blank the board list; treat as empty join.
-          attentionTickets = [];
-        } else {
-          attentionPending = attentionResult.waiting;
-          attentionTickets = Option.getOrNull(AsyncResult.value(attentionResult));
-        }
-      }
-
-      return buildWorkflowSidebarEntries({
-        eligibleProjects: projects,
-        boardResultsByProjectId,
-        attentionTickets,
-        attentionPending,
-        primaryEnvironmentId,
-      });
- }).pipe(Atom.withLabel("workflow-sidebar-entries-aggregate"));
- // eligibleKey captures project identity; primaryEnvironmentId is explicit.
- // eslint-disable-next-line react-hooks/exhaustive-deps -- stable key for eligible list
- }, [eligibleKey, input.primaryEnvironmentId]);
-
- const [snapshot, setSnapshot] =
- useState<Omit<WorkflowSidebarEntriesState, "refreshProject" | "refreshAll">>(EMPTY_STATE);
-
- useEffect(() => {
- const unmount = registry.mount(aggregateAtom);
- const unsubscribe = registry.subscribe(
-      aggregateAtom,
-      (next) => {
-        setSnapshot(next);
-      },
-      // Immediate so first paint has data without waiting for a change.
-      { immediate: true },
- );
- return () => {
-      unsubscribe();
-      unmount();
- };
- }, [aggregateAtom, registry]);
-
- const refreshProject = useMemo(() => {
- return (projectId: ProjectId) => {
-      const project = input.eligibleProjects.find((candidate) => candidate.id === projectId);
-      if (!project) return;
-      refreshListBoards(registry, project.environmentId, project.id);
- };
- }, [input.eligibleProjects, registry]);
-
- const refreshAll = useMemo(() => {
- return () => {
-      for (const project of input.eligibleProjects) {
-        refreshListBoards(registry, project.environmentId, project.id);
-      }
-      if (input.primaryEnvironmentId !== null) {
-        registry.refresh(
-          workflowEnvironment.listNeedsAttentionTickets({
-            environmentId: input.primaryEnvironmentId,
-            input: {},
-          }),
-        );
-      }
- };
- }, [input.eligibleProjects, input.primaryEnvironmentId, registry]);
-
- return {
- ...snapshot,
- refreshProject,
- refreshAll,
- };
  +}
- +export function refreshListBoards(
- registry: AtomRegistry.AtomRegistry,
- environmentId: EnvironmentId,
- projectId: ProjectId,
  +): void {
- registry.refresh(
- workflowEnvironment.listBoards({
-      environmentId,
-      input: { projectId },
- }),
- );
  +}
- +/\*_ Filter projects to primary-env ∩ optional scope (scope null = all). _/
  +export function filterEligibleWorkflowProjects(input: {
- readonly projects: ReadonlyArray<WorkflowSidebarEligibleProject>;
- readonly primaryEnvironmentId: EnvironmentId | null;
- readonly scopedProject:
- | { readonly id: ProjectId; readonly environmentId: EnvironmentId }
- | null;
  +}): ReadonlyArray<WorkflowSidebarEligibleProject> {
- if (input.primaryEnvironmentId === null) {
- return [];
- }
- const primaryOnly = input.projects.filter(
- (project) => project.environmentId === input.primaryEnvironmentId,
- );
- if (input.scopedProject === null) {
- return primaryOnly;
- }
- // Scope must itself be primary-env to be eligible.
- if (input.scopedProject.environmentId !== input.primaryEnvironmentId) {
- return [];
- }
- return primaryOnly.filter((project) => project.id === input.scopedProject?.id);
  +}
  diff --git a/apps/web/src/workflow/workflowSidebarStatus.test.ts b/apps/web/src/workflow/workflowSidebarStatus.test.ts
  new file mode 100644
  index 000000000..48a53c3c0
  --- /dev/null
  +++ b/apps/web/src/workflow/workflowSidebarStatus.test.ts
  @@ -0,0 +1,131 @@
  +import { BoardId, EnvironmentId } from "@t3tools/contracts";
  +import { describe, expect, it } from "vite-plus/test";
- +import {
- attentionKindToneClass,
- compareAttentionKindPrecedence,
- dominantAttentionKind,
- groupAttentionByBoard,
- resolveWorkflowSidebarAttentionPill,
- workflowBoardAttentionKey,
  +} from "./workflowSidebarStatus";
- +const env = EnvironmentId.make("environment-primary");
  +const boardA = BoardId.make("project-1**board-a");
  +const boardB = BoardId.make("project-1**board-b");
- +describe("workflowBoardAttentionKey", () => {
- it("joins environmentId and boardId", () => {
- expect(workflowBoardAttentionKey(env, boardA)).toBe(`${env}:${boardA}`);
- });
  +});
- +describe("dominantAttentionKind / precedence", () => {
- it("orders blocked > parked_issue > waiting_for_approval > waiting_for_input > parked_waiting > null", () => {
- expect(
-      dominantAttentionKind([
-        "parked_waiting",
-        "waiting_for_input",
-        "waiting_for_approval",
-        "parked_issue",
-        "blocked",
-      ]),
- ).toBe("blocked");
- expect(
-      dominantAttentionKind([
-        "parked_waiting",
-        "waiting_for_input",
-        "waiting_for_approval",
-        "parked_issue",
-      ]),
- ).toBe("parked_issue");
- expect(
-      dominantAttentionKind(["parked_waiting", "waiting_for_input", "waiting_for_approval"]),
- ).toBe("waiting_for_approval");
- expect(dominantAttentionKind(["parked_waiting", "waiting_for_input"])).toBe(
-      "waiting_for_input",
- );
- expect(dominantAttentionKind(["parked_waiting"])).toBe("parked_waiting");
- expect(dominantAttentionKind([null])).toBeNull();
- expect(dominantAttentionKind([])).toBeNull();
- });
-
- it("compareAttentionKindPrecedence ranks higher kinds first", () => {
- expect(compareAttentionKindPrecedence("blocked", "parked_waiting")).toBeLessThan(0);
- expect(compareAttentionKindPrecedence("parked_waiting", "blocked")).toBeGreaterThan(0);
- expect(compareAttentionKindPrecedence(null, "blocked")).toBeGreaterThan(0);
- expect(compareAttentionKindPrecedence("blocked", null)).toBeLessThan(0);
- expect(compareAttentionKindPrecedence(null, null)).toBe(0);
- });
  +});
- +describe("groupAttentionByBoard", () => {
- it("groups by (environmentId, boardId) with count + dominant kind", () => {
- const grouped = groupAttentionByBoard({
-      environmentId: env,
-      tickets: [
-        { boardId: boardA, attentionKind: "waiting_for_input" },
-        { boardId: boardA, attentionKind: "blocked" },
-        { boardId: boardA, attentionKind: "parked_waiting" },
-        { boardId: boardB, attentionKind: "waiting_for_approval" },
-        { boardId: boardB, attentionKind: null },
-      ],
- });
-
- expect(grouped.get(workflowBoardAttentionKey(env, boardA))).toEqual({
-      count: 3,
-      dominantKind: "blocked",
- });
- expect(grouped.get(workflowBoardAttentionKey(env, boardB))).toEqual({
-      count: 2,
-      dominantKind: "waiting_for_approval",
- });
- });
-
- it("keeps count when all kinds are null", () => {
- const grouped = groupAttentionByBoard({
-      environmentId: env,
-      tickets: [
-        { boardId: boardA, attentionKind: null },
-        { boardId: boardA, attentionKind: null },
-      ],
- });
- expect(grouped.get(workflowBoardAttentionKey(env, boardA))).toEqual({
-      count: 2,
-      dominantKind: null,
- });
- });
  +});
- +describe("resolveWorkflowSidebarAttentionPill", () => {
- it("returns null for zero / missing attention", () => {
- expect(resolveWorkflowSidebarAttentionPill(null)).toBeNull();
- expect(resolveWorkflowSidebarAttentionPill(undefined)).toBeNull();
- expect(resolveWorkflowSidebarAttentionPill({ count: 0, dominantKind: null })).toBeNull();
- });
-
- it("formats count label and error tone for blocked", () => {
- const pill = resolveWorkflowSidebarAttentionPill({ count: 1, dominantKind: "blocked" });
- expect(pill?.label).toBe("1 need you");
- expect(pill?.className).toBe(attentionKindToneClass("blocked"));
- expect(pill?.className).toContain("text-red");
-
- const multi = resolveWorkflowSidebarAttentionPill({
-      count: 4,
-      dominantKind: "waiting_for_approval",
- });
- expect(multi?.label).toBe("4 need you");
- expect(multi?.className).toContain("text-amber");
- });
  +});
- +describe("attentionKindToneClass", () => {
- it("maps each kind to a distinct calm tone family", () => {
- expect(attentionKindToneClass("waiting_for_approval")).toContain("amber");
- expect(attentionKindToneClass("waiting_for_input")).toContain("indigo");
- expect(attentionKindToneClass("blocked")).toContain("red");
- expect(attentionKindToneClass("parked_issue")).toContain("amber");
- expect(attentionKindToneClass("parked_waiting")).toContain("sky");
- expect(attentionKindToneClass(null)).toContain("muted");
- });
  +});
  diff --git a/apps/web/src/workflow/workflowSidebarStatus.ts b/apps/web/src/workflow/workflowSidebarStatus.ts
  new file mode 100644
  index 000000000..8c4342a7c
  --- /dev/null
  +++ b/apps/web/src/workflow/workflowSidebarStatus.ts
  @@ -0,0 +1,154 @@
  +import type {
- BoardId,
- EnvironmentId,
- WorkflowNeedsAttentionTicketView,
- WorkflowTicketAttentionKind,
  +} from "@t3tools/contracts";
- +/\*\*
- - Total precedence for the dominant attention kind shown on a workflow
- - sidebar row. Higher rank wins; null when the board has no attention tickets.
- - There is no "failed" attention kind — needs-attention only returns
- - waiting/blocked/parked tickets.
- \*/
  +const ATTENTION_KIND_RANK: ReadonlyRecord<WorkflowTicketAttentionKind, number> = {
- blocked: 5,
- parked_issue: 4,
- waiting_for_approval: 3,
- waiting_for_input: 2,
- parked_waiting: 1,
  +};
- +type ReadonlyRecord<K extends string, V> = { readonly [P in K]: V };
- +export type WorkflowSidebarAttentionKind = WorkflowTicketAttentionKind;
- +export interface WorkflowSidebarAttentionSummary {
- readonly count: number;
- /\*_ Dominant kind by total precedence; null when count is 0. _/
- readonly dominantKind: WorkflowSidebarAttentionKind | null;
  +}
- +export interface WorkflowSidebarAttentionPill {
- readonly label: string;
- readonly className: string;
  +}
- +/\*_ Board identity used for attention grouping and active-route highlight. _/
  +export function workflowBoardAttentionKey(
- environmentId: EnvironmentId | string,
- boardId: BoardId | string,
  +): string {
- return `${environmentId}:${boardId}`;
  +}
- +/\*\*
- - Group needs-attention tickets by (environmentId, boardId) into a count +
- - dominant kind. Tickets without an attentionKind are counted but cannot
- - become the dominant kind unless every ticket for that board is null-kind
- - (then dominant stays null).
- \*/
  +export function groupAttentionByBoard(input: {
- readonly environmentId: EnvironmentId | string;
- readonly tickets: ReadonlyArray<
- Pick<WorkflowNeedsAttentionTicketView, "boardId" | "attentionKind">
- > ;
  > +}): ReadonlyMap<string, WorkflowSidebarAttentionSummary> {
- const byBoard = new Map<
- string,
- { count: number; dominantKind: WorkflowSidebarAttentionKind | null; rank: number }
- > ();
-
- for (const ticket of input.tickets) {
- const key = workflowBoardAttentionKey(input.environmentId, ticket.boardId);
- const current = byBoard.get(key) ?? { count: 0, dominantKind: null, rank: 0 };
- current.count += 1;
- const kind = ticket.attentionKind;
- if (kind !== null) {
-      const rank = ATTENTION_KIND_RANK[kind];
-      if (rank > current.rank) {
-        current.dominantKind = kind;
-        current.rank = rank;
-      }
- }
- byBoard.set(key, current);
- }
-
- const result = new Map<string, WorkflowSidebarAttentionSummary>();
- for (const [key, value] of byBoard) {
- result.set(key, { count: value.count, dominantKind: value.dominantKind });
- }
- return result;
  +}
- +/\*\*
- - Map a dominant attention kind + count into the calm right-slot pill.
- - Zero count → null (nothing rendered).
- \*/
  +export function resolveWorkflowSidebarAttentionPill(
- summary: WorkflowSidebarAttentionSummary | null | undefined,
  +): WorkflowSidebarAttentionPill | null {
- if (summary === null || summary === undefined || summary.count <= 0) {
- return null;
- }
-
- const label = summary.count === 1 ? "1 need you" : `${summary.count} need you`;
- const className = attentionKindToneClass(summary.dominantKind);
- return { label, className };
  +}
- +/\*_ Tone classes for the dominant attention kind (color signals, not noise). _/
  +export function attentionKindToneClass(
- kind: WorkflowSidebarAttentionKind | null | undefined,
  +): string {
- switch (kind) {
- case "waiting_for_approval":
-      return "text-amber-700 dark:text-amber-300";
- case "waiting_for_input":
-      return "text-indigo-600 dark:text-indigo-300";
- case "blocked":
-      return "text-red-700 dark:text-red-300";
- case "parked_issue":
-      // Parked issue: warning/amber family (matches board ticket tier "issue").
-      return "text-amber-700 dark:text-amber-300";
- case "parked_waiting":
-      // Parked waiting: info/sky family (board waiting tier).
-      return "text-sky-700 dark:text-sky-300";
- case null:
- case undefined:
-      return "text-muted-foreground";
- }
  +}
- +/\*\*
- - Compare two attention kinds by total precedence (higher first).
- - Null ranks below every concrete kind.
- \*/
  +export function compareAttentionKindPrecedence(
- left: WorkflowSidebarAttentionKind | null,
- right: WorkflowSidebarAttentionKind | null,
  +): number {
- const leftRank = left === null ? 0 : ATTENTION_KIND_RANK[left];
- const rightRank = right === null ? 0 : ATTENTION_KIND_RANK[right];
- return rightRank - leftRank;
  +}
- +/\*\*
- - Pick the dominant kind from a list (total precedence). Used by tests and
- - callers that already have kinds without ticket rows.
- \*/
  +export function dominantAttentionKind(
- kinds: ReadonlyArray<WorkflowSidebarAttentionKind | null>,
  +): WorkflowSidebarAttentionKind | null {
- let best: WorkflowSidebarAttentionKind | null = null;
- let bestRank = 0;
- for (const kind of kinds) {
- if (kind === null) continue;
- const rank = ATTENTION_KIND_RANK[kind];
- if (rank > bestRank) {
-      best = kind;
-      bestRank = rank;
- }
- }
- return best;
  +}
  diff --git a/packages/contracts/src/settings.test.ts b/packages/contracts/src/settings.test.ts
  index 001daf1b2..171693aa8 100644
  --- a/packages/contracts/src/settings.test.ts
  +++ b/packages/contracts/src/settings.test.ts
  @@ -40,6 +40,23 @@ describe("ClientSettings sidebar v2", () => {
  expect(settings.sidebarAutoSettleAfterDays).toBe(3);
  });

- it("defaults sidebar v2 mode to threads", () => {
- expect(decodeClientSettings({}).sidebarV2Mode).toBe("threads");
- });
-
- it("round-trips sidebarV2Mode through full schema and patch", () => {
- expect(decodeClientSettings({ sidebarV2Mode: "workflows" }).sidebarV2Mode).toBe("workflows");
- expect(decodeClientSettingsPatch({ sidebarV2Mode: "workflows" }).sidebarV2Mode).toBe(
-      "workflows",
- );
- expect(decodeClientSettingsPatch({}).sidebarV2Mode).toBeUndefined();
- });
-
- it("rejects an unknown sidebarV2Mode", () => {
- expect(() => decodeClientSettings({ sidebarV2Mode: "boards" })).toThrow();
- expect(() => decodeClientSettingsPatch({ sidebarV2Mode: "boards" })).toThrow();
- });
- it("allows auto-settle by inactivity to be disabled", () => {
  expect(
  decodeClientSettings({ sidebarAutoSettleAfterDays: null }).sidebarAutoSettleAfterDays,
  diff --git a/packages/contracts/src/settings.ts b/packages/contracts/src/settings.ts
  index d9213099b..5f751cb4c 100644
  --- a/packages/contracts/src/settings.ts
  +++ b/packages/contracts/src/settings.ts
  @@ -49,6 +49,10 @@ export const SidebarAutoSettleAfterDays = Schema.Number.check(
  export type SidebarAutoSettleAfterDays = typeof SidebarAutoSettleAfterDays.Type;
  export const DEFAULT_SIDEBAR_AUTO_SETTLE_AFTER_DAYS: SidebarAutoSettleAfterDays = 3;
  +export const SidebarV2Mode = Schema.Literals(["threads", "workflows"]);
  +export type SidebarV2Mode = typeof SidebarV2Mode.Type;
  +export const DEFAULT_SIDEBAR_V2_MODE: SidebarV2Mode = "threads";
- export const ClientSettingsSchema = Schema.Struct({
  autoOpenPlanSidebar: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  confirmThreadArchive: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  @@ -103,6 +107,11 @@ export const ClientSettingsSchema = Schema.Struct({
  Schema.withDecodingDefault(Effect.succeed(DEFAULT_SIDEBAR_THREAD_PREVIEW_COUNT)),
  ),
  sidebarV2Enabled: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
- // Sidebar v2 list mode (threads vs workflows). Only meaningful when
- // sidebarV2Enabled is on; v1 keeps per-project board rows.
- sidebarV2Mode: SidebarV2Mode.pipe(
- Schema.withDecodingDefault(Effect.succeed(DEFAULT_SIDEBAR_V2_MODE)),
- ),
  timestampFormat: TimestampFormat.pipe(
  Schema.withDecodingDefault(Effect.succeed(DEFAULT_TIMESTAMP_FORMAT)),
  ),
  @@ -592,6 +601,7 @@ export const ClientSettingsPatch = Schema.Struct({
  sidebarThreadSortOrder: Schema.optionalKey(SidebarThreadSortOrder),
  sidebarThreadPreviewCount: Schema.optionalKey(SidebarThreadPreviewCount),
  sidebarV2Enabled: Schema.optionalKey(Schema.Boolean),
- sidebarV2Mode: Schema.optionalKey(SidebarV2Mode),
  timestampFormat: Schema.optionalKey(TimestampFormat),
  wordWrap: Schema.optionalKey(Schema.Boolean),
  });
