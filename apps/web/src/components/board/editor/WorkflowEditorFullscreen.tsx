import { type ReactNode, useEffect } from "react";

export function WorkflowEditorFullscreen(props: {
  readonly children: ReactNode;
  readonly open: boolean;
  readonly onClose: () => void;
}) {
  const { children, onClose, open } = props;

  useEffect(() => {
    if (!open) {
      return;
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onClose();
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose, open]);

  useEffect(() => {
    if (!open) {
      return;
    }

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, [open]);

  if (!open) {
    return null;
  }

  return (
    <div
      aria-label="Workflow editor"
      aria-modal="true"
      className="fixed inset-0 z-50 flex min-h-0 flex-col bg-background text-foreground wco:mt-[env(titlebar-area-height)] wco:h-[calc(100%-env(titlebar-area-height))]"
      data-workflow-editor-surface="fullscreen"
      role="dialog"
    >
      <div className="flex min-h-0 flex-1 flex-col">{children}</div>
    </div>
  );
}
