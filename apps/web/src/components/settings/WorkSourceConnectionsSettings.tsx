import { PlusIcon, Trash2Icon } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import type { WorkSourceConnectionView } from "@t3tools/contracts/workSource";

import { SettingsPageContainer, SettingsSection } from "./settingsLayout";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Spinner } from "~/components/ui/spinner";
import { toastManager, stackedThreadToast } from "~/components/ui/toast";
import {
  Dialog,
  DialogClose,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
  DialogDescription,
  DialogTrigger,
} from "~/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "~/components/ui/alert-dialog";
import { readEnvironmentApi } from "~/environmentApi";
import { usePrimaryEnvironmentId } from "~/environments/primary";

const ITEM_ROW_CLASSNAME = "border-t border-border/60 px-4 py-4 first:border-t-0 sm:px-5";

// ─── connection row ───────────────────────────────────────────────────────────

function ConnectionRow({
  connection,
  isDeleting,
  onDelete,
}: {
  readonly connection: WorkSourceConnectionView;
  readonly isDeleting: boolean;
  readonly onDelete: (connectionRef: string) => void;
}) {
  const [confirmOpen, setConfirmOpen] = useState(false);

  return (
    <div className={ITEM_ROW_CLASSNAME}>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0 space-y-0.5">
          <p className="text-sm font-medium text-foreground">{connection.displayName}</p>
          <p className="text-xs text-muted-foreground">
            {connection.provider} · ref: {connection.connectionRef}
          </p>
        </div>
        <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
          <Button
            size="xs"
            variant="destructive-outline"
            disabled={isDeleting}
            onClick={() => setConfirmOpen(true)}
          >
            {isDeleting ? (
              <>
                <Spinner className="size-3" />
                Removing…
              </>
            ) : (
              <>
                <Trash2Icon className="size-3.5" />
                Remove
              </>
            )}
          </Button>
          <AlertDialogPopup className="max-w-sm">
            <AlertDialogHeader>
              <AlertDialogTitle>Remove connection?</AlertDialogTitle>
              <AlertDialogDescription>
                Boards using &ldquo;{connection.displayName}&rdquo; will stop syncing new work items.
                Existing synced tickets are unaffected.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogClose render={<Button variant="outline" />}>Cancel</AlertDialogClose>
              <Button
                variant="destructive"
                onClick={() => {
                  setConfirmOpen(false);
                  onDelete(connection.connectionRef);
                }}
              >
                Remove connection
              </Button>
            </AlertDialogFooter>
          </AlertDialogPopup>
        </AlertDialog>
      </div>
    </div>
  );
}

// ─── add-connection dialog ────────────────────────────────────────────────────

function AddConnectionDialog({
  onAdd,
}: {
  readonly onAdd: (input: {
    provider: "github" | "asana";
    displayName: string;
    token: string;
  }) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [provider, setProvider] = useState<"github" | "asana">("github");
  const [displayName, setDisplayName] = useState("");
  const [token, setToken] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const reset = () => {
    setProvider("github");
    setDisplayName("");
    setToken("");
  };

  const handleSubmit = async () => {
    if (!displayName.trim() || !token.trim()) return;
    setSubmitting(true);
    try {
      await onAdd({ provider, displayName: displayName.trim(), token: token.trim() });
      reset();
      setOpen(false);
    } catch (error: unknown) {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Could not add connection",
          description: error instanceof Error ? error.message : "An unknown error occurred.",
        }),
      );
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) reset();
      }}
    >
      <DialogTrigger
        render={
          <Button size="xs" variant="default">
            <PlusIcon className="size-3" />
            Add connection
          </Button>
        }
      />
      <DialogPopup className="max-w-md">
        <DialogHeader>
          <DialogTitle>Add work-source connection</DialogTitle>
          <DialogDescription>
            Enter a personal access token (PAT) for the provider. The token is stored server-side
            and used only for syncing issues/tasks.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel className="space-y-4">
          <label className="block">
            <span className="mb-1.5 block text-xs font-medium text-foreground">Provider</span>
            <select
              className="h-8.5 w-full rounded-md border border-input bg-background px-3 text-sm text-foreground"
              value={provider}
              disabled={submitting}
              onChange={(e) => setProvider(e.currentTarget.value as "github" | "asana")}
            >
              <option value="github">GitHub</option>
              <option value="asana">Asana</option>
            </select>
          </label>
          <label className="block">
            <span className="mb-1.5 block text-xs font-medium text-foreground">Display name</span>
            <Input
              value={displayName}
              disabled={submitting}
              placeholder={provider === "github" ? "My GitHub PAT" : "My Asana PAT"}
              autoFocus
              onChange={(e) => setDisplayName(e.currentTarget.value)}
            />
          </label>
          <label className="block">
            <span className="mb-1.5 block text-xs font-medium text-foreground">
              Personal access token
            </span>
            <Input
              type="password"
              value={token}
              disabled={submitting}
              placeholder={provider === "github" ? "ghp_…" : "Paste your token (no \"Bearer\" prefix)"}
              onChange={(e) => setToken(e.currentTarget.value)}
            />
            <p className="mt-1 text-[11px] text-muted-foreground">
              {provider === "github"
                ? "Needs repo:read and issues:read scopes."
                : "Use a personal access token from your Asana profile."}
            </p>
          </label>
        </DialogPanel>
        <DialogFooter variant="bare">
          <DialogClose render={<Button variant="outline" disabled={submitting} />}>
            Cancel
          </DialogClose>
          <Button
            disabled={submitting || !displayName.trim() || !token.trim()}
            onClick={() => void handleSubmit()}
          >
            {submitting ? "Adding…" : "Add connection"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

// ─── main settings component ─────────────────────────────────────────────────

export function WorkSourceConnectionsSettings() {
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const api = primaryEnvironmentId ? readEnvironmentApi(primaryEnvironmentId) : undefined;
  const workflowApi = api?.workflow;

  const [connections, setConnections] = useState<ReadonlyArray<WorkSourceConnectionView> | null>(
    null,
  );
  const [loadError, setLoadError] = useState<string | null>(null);
  const [deletingRef, setDeletingRef] = useState<string | null>(null);

  const loadConnections = useCallback(() => {
    if (!workflowApi) return;
    setLoadError(null);
    workflowApi
      .listWorkSourceConnections({})
      .then((result) => setConnections(result))
      .catch((error: unknown) => {
        setLoadError(error instanceof Error ? error.message : "Failed to load connections.");
      });
  }, [workflowApi]);

  useEffect(() => {
    loadConnections();
  }, [loadConnections]);

  const handleAdd = useCallback(
    async (input: { provider: "github" | "asana"; displayName: string; token: string }) => {
      if (!workflowApi) throw new Error("No environment connected.");
      const created = await workflowApi.createWorkSourceConnection(input);
      setConnections((current) => (current ? [...current, created] : [created]));
      toastManager.add({ type: "success", title: "Connection added" });
    },
    [workflowApi],
  );

  const handleDelete = useCallback(
    (connectionRef: string) => {
      if (!workflowApi) return;
      setDeletingRef(connectionRef);
      workflowApi
        .deleteWorkSourceConnection({ connectionRef })
        .then(() => {
          setConnections((current) =>
            current ? current.filter((c) => c.connectionRef !== connectionRef) : current,
          );
          toastManager.add({ type: "success", title: "Connection removed" });
        })
        .catch((error: unknown) => {
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: "Could not remove connection",
              description: error instanceof Error ? error.message : "An unknown error occurred.",
            }),
          );
        })
        .finally(() => setDeletingRef(null));
    },
    [workflowApi],
  );

  if (!workflowApi) {
    return (
      <SettingsPageContainer>
        <SettingsSection title="Work-Source Connections">
          <div className={ITEM_ROW_CLASSNAME}>
            <p className="text-sm text-muted-foreground">No environment connected.</p>
          </div>
        </SettingsSection>
      </SettingsPageContainer>
    );
  }

  return (
    <SettingsPageContainer>
      <SettingsSection
        title="Work-Source Connections"
        headerAction={<AddConnectionDialog onAdd={handleAdd} />}
      >
        {loadError ? (
          <div className={ITEM_ROW_CLASSNAME}>
            <p className="text-sm text-destructive">{loadError}</p>
          </div>
        ) : connections === null ? (
          <div className={ITEM_ROW_CLASSNAME}>
            <p className="flex items-center gap-1.5 text-sm text-muted-foreground">
              <Spinner className="size-3.5" />
              Loading…
            </p>
          </div>
        ) : connections.length === 0 ? (
          <div className={ITEM_ROW_CLASSNAME}>
            <p className="text-sm text-muted-foreground">
              No work-source connections yet. Add one to start syncing GitHub issues or Asana tasks.
            </p>
          </div>
        ) : (
          connections.map((connection) => (
            <ConnectionRow
              key={connection.connectionRef}
              connection={connection}
              isDeleting={deletingRef === connection.connectionRef}
              onDelete={handleDelete}
            />
          ))
        )}
      </SettingsSection>
    </SettingsPageContainer>
  );
}
