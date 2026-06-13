import type { WorkflowWebhookConfig } from "@t3tools/contracts";
import { CopyIcon, RefreshCwIcon, WebhookIcon } from "lucide-react";
import { useRef, useState } from "react";

import { Button } from "~/components/ui/button";
import {
  Dialog,
  DialogDescription,
  DialogHeader,
  DialogPopup,
  DialogTitle,
} from "~/components/ui/dialog";

const exampleBody = JSON.stringify({
  name: "ci.passed",
  ticketId: "<ticketId>",
  deliveryId: "run-123",
  payload: { status: "green" },
});

export const webhookCurlExample = (url: string, token: string): string =>
  [
    `curl -X POST ${url} \\`,
    `  -H 'x-t3-webhook-token: ${token}' \\`,
    `  -H 'content-type: application/json' \\`,
    `  -d '${exampleBody}'`,
  ].join("\n");

/**
 * Per-board webhook ingress config. The secret is shown exactly once — on
 * first open (which provisions it) or after a rotation — and only its prefix
 * afterwards.
 */
export function WebhookConfigDialog({
  disabled,
  onFetchConfig,
}: {
  readonly disabled: boolean;
  readonly onFetchConfig: (rotate: boolean) => Promise<WorkflowWebhookConfig>;
}) {
  const [open, setOpen] = useState(false);
  const [config, setConfig] = useState<WorkflowWebhookConfig | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const requestRef = useRef(0);

  const load = async (rotate: boolean) => {
    const requestId = ++requestRef.current;
    setError(null);
    setCopied(false);
    try {
      const next = await onFetchConfig(rotate);
      if (requestRef.current === requestId) {
        setConfig(next);
      }
    } catch (cause) {
      if (requestRef.current === requestId) {
        setError(cause instanceof Error ? cause.message : "Failed to load the webhook config.");
      }
    }
  };

  const origin = typeof window === "undefined" ? "" : window.location.origin;
  const url = config === null ? "" : `${origin}${config.path}`;
  const curl =
    config === null ? "" : webhookCurlExample(url, config.token ?? "<token shown on rotate>");

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        setOpen(nextOpen);
        if (!nextOpen) {
          requestRef.current += 1;
          // Never keep a revealed secret in memory after closing.
          setConfig(null);
          setCopied(false);
        }
      }}
    >
      <Button
        type="button"
        size="xs"
        variant="ghost"
        disabled={disabled}
        title="Let CI, PR automation, or cron move tickets on this board"
        onClick={() => {
          setOpen(true);
          void load(false);
        }}
      >
        <WebhookIcon className="size-3.5" />
        Webhook
      </Button>
      <DialogPopup className="max-h-[calc(100dvh-2rem)] max-w-xl overflow-hidden">
        <div className="flex min-h-0 flex-col">
          <DialogHeader>
            <DialogTitle>Board webhook</DialogTitle>
            <DialogDescription>
              External systems POST events here to move correlated tickets through their lane's
              external-event matchers.
            </DialogDescription>
          </DialogHeader>
          <div
            className="min-h-0 flex-1 space-y-4 overflow-y-auto px-6 pt-1 pb-4"
            data-testid="webhook-config"
          >
            {error !== null ? (
              <p className="text-xs text-destructive-foreground" role="alert">
                {error}
              </p>
            ) : config === null ? (
              <p className="text-sm text-muted-foreground">Loading…</p>
            ) : (
              <>
                <div className="grid gap-1.5">
                  <span className="text-xs font-medium text-foreground">Endpoint</span>
                  <code className="block truncate rounded-md border border-border/70 bg-muted/30 px-2.5 py-1.5 text-xs text-foreground">
                    POST {url}
                  </code>
                </div>
                <div className="grid gap-1.5">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-xs font-medium text-foreground">
                      Token (x-t3-webhook-token)
                    </span>
                    <Button size="xs" variant="outline" onClick={() => void load(true)}>
                      <RefreshCwIcon className="size-3" />
                      Rotate
                    </Button>
                  </div>
                  {config.token !== undefined ? (
                    <>
                      <code
                        className="block break-all rounded-md border border-warning/45 bg-warning/8 px-2.5 py-1.5 text-xs text-foreground"
                        data-testid="webhook-token"
                      >
                        {config.token}
                      </code>
                      <p className="text-[11px] text-warning">
                        Copy it now — it is shown only this once. Rotating invalidates the old
                        token.
                      </p>
                    </>
                  ) : (
                    <p className="text-xs text-muted-foreground">
                      Active token starts with{" "}
                      <code className="text-foreground">{config.tokenPrefix ?? "?"}</code>… — the
                      full secret was shown when it was created. Rotate to issue a new one.
                    </p>
                  )}
                </div>
                <div className="grid gap-1.5">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-xs font-medium text-foreground">Example</span>
                    <Button
                      size="xs"
                      variant="ghost"
                      onClick={() => {
                        void navigator.clipboard?.writeText(curl).then(() => setCopied(true));
                      }}
                    >
                      <CopyIcon className="size-3" />
                      {copied ? "Copied" : "Copy"}
                    </Button>
                  </div>
                  <pre className="overflow-x-auto rounded-md border border-border/70 bg-muted/30 px-2.5 py-1.5 text-[11px] leading-4 text-foreground">
                    {curl}
                  </pre>
                  <p className="text-[11px] text-muted-foreground">
                    Correlate by <code>ticketId</code> or <code>branch</code> ("workflow/&lt;
                    ticketId&gt;"). Optional <code>deliveryId</code> deduplicates retries.
                  </p>
                </div>
              </>
            )}
          </div>
        </div>
      </DialogPopup>
    </Dialog>
  );
}
