import { EnvironmentId, ProjectId } from "@t3tools/contracts";

// Tiny event bus allowing components to programmatically open the command palette
// without owning its React state.
const COMMAND_PALETTE_OPEN_EVENT = "t3code:open-command-palette";
const CREATE_WORKFLOW_EVENT = "t3code:request-create-workflow";

export interface CommandPaletteOpenDetail {
  readonly open?: "add-project" | "new-thread-in" | "new-workflow-in";
}

/** Intent: open CreateWorkflowDialog for a specific primary-env project. */
export interface RequestCreateWorkflowDetail {
  readonly projectId: ProjectId;
  readonly environmentId: EnvironmentId;
}

export function openCommandPalette(detail?: CommandPaletteOpenDetail): void {
  window.dispatchEvent(
    new CustomEvent(COMMAND_PALETTE_OPEN_EVENT, detail ? { detail } : undefined),
  );
}

export function onOpenCommandPalette(
  listener: (detail: CommandPaletteOpenDetail) => void,
): () => void {
  const handler = (event: Event) => {
    if (!(event instanceof CustomEvent)) {
      listener({});
      return;
    }
    const detail = event.detail;
    if (detail === null || detail === undefined || typeof detail !== "object") {
      listener({});
      return;
    }
    listener(detail);
  };
  window.addEventListener(COMMAND_PALETTE_OPEN_EVENT, handler);
  return () => window.removeEventListener(COMMAND_PALETTE_OPEN_EVENT, handler);
}

/** Emitted by the palette new-workflow-in submenu (and SidebarV2 direct create). */
export function requestCreateWorkflow(detail: RequestCreateWorkflowDetail): void {
  window.dispatchEvent(new CustomEvent(CREATE_WORKFLOW_EVENT, { detail }));
}

export function onRequestCreateWorkflow(
  listener: (detail: RequestCreateWorkflowDetail) => void,
): () => void {
  const handler = (event: Event) => {
    if (!(event instanceof CustomEvent)) return;
    const detail = event.detail;
    if (detail === null || detail === undefined || typeof detail !== "object") return;
    if (!("projectId" in detail) || !("environmentId" in detail)) return;
    const projectId = Reflect.get(detail, "projectId");
    const environmentId = Reflect.get(detail, "environmentId");
    if (typeof projectId !== "string" || typeof environmentId !== "string") return;
    if (projectId.length === 0 || environmentId.length === 0) return;
    listener({
      projectId: ProjectId.make(projectId),
      environmentId: EnvironmentId.make(environmentId),
    });
  };
  window.addEventListener(CREATE_WORKFLOW_EVENT, handler);
  return () => window.removeEventListener(CREATE_WORKFLOW_EVENT, handler);
}

/** Read at event time so consumers do not subscribe to transient dialog state. */
export function isCommandPaletteOpen(): boolean {
  return (
    typeof document !== "undefined" && document.querySelector("[data-command-palette]") !== null
  );
}
