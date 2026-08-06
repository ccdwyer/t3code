import {
  TicketId,
  type EnvironmentApi,
  type WorkflowTicketArtifact,
  type WorkflowTicketArtifactKind,
  type WorkflowTicketArtifactView,
  type WorkflowTicketArtifactsResult,
} from "@t3tools/contracts";
import {
  ExternalLinkIcon,
  FileIcon,
  FileTextIcon,
  FilmIcon,
  GlobeIcon,
  ImageIcon,
} from "lucide-react";
import { useState } from "react";

import {
  artifactsInServerOrder,
  contentStateFor,
  formatBytes,
  needsFetchOnExpand,
  rendererForKind,
} from "~/workflow/artifactView";
import { useNowTick } from "~/workflow/useNowTick";

import ChatMarkdown from "../ChatMarkdown";
import { ageFrom } from "./views/boardModel";

/**
 * Durable ticket artifacts (spec: 2026-08-05-ticket-artifacts-design):
 * rows in server canonical order with kind icon, name, description,
 * "updated Xm ago", size — plus per-kind viewers. The legacy worktree
 * scratch listing survives as a collapsed "Working files (worktree)"
 * sub-section. Loaded lazily when the section opens; every re-open
 * refetches the list so signed asset URLs are re-issued (>6h-idle
 * broken-media residual documented in the spec).
 */

const KIND_ICONS: Record<
  WorkflowTicketArtifactKind,
  React.ComponentType<{ className?: string; "aria-hidden"?: boolean }>
> = {
  markdown: FileTextIcon,
  text: FileIcon,
  html: GlobeIcon,
  image: ImageIcon,
  video: FilmIcon,
};

/** Row anatomy: kind icon, name, description, "updated Xm ago", size. */
export function ArtifactRowHeader({
  artifact,
  now,
}: {
  readonly artifact: WorkflowTicketArtifactView;
  readonly now: number;
}) {
  const Icon = KIND_ICONS[artifact.kind];
  return (
    <span className="flex min-w-0 flex-1 items-center gap-2">
      <Icon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-xs font-medium text-foreground">{artifact.name}</span>
        {artifact.description !== undefined && artifact.description !== "" ? (
          <span className="block truncate text-[11px] font-normal text-muted-foreground">
            {artifact.description}
          </span>
        ) : null}
      </span>
      <span className="flex shrink-0 items-center gap-2 text-[10px] font-normal text-muted-foreground">
        <span>updated {ageFrom(artifact.updatedAt, now)} ago</span>
        <span className="font-mono">{formatBytes(artifact.byteSize)}</span>
      </span>
    </span>
  );
}

/** Muted state for rows whose blob failed verified-open on the server. */
export function ArtifactUnavailableNotice() {
  return <p className="text-[11px] text-muted-foreground italic">content unavailable</p>;
}

/** HTML is never inlined — external open only, PR-link pattern. */
export function ArtifactOpenInBrowser({ url }: { readonly url: string }) {
  return (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      className="inline-flex shrink-0 items-center gap-1 text-[11px] font-medium text-foreground underline-offset-2 hover:underline"
      data-testid="artifact-open-in-browser"
    >
      Open in browser
      <ExternalLinkIcon className="size-3" aria-hidden />
    </a>
  );
}

function ArtifactCaption({ description }: { readonly description: string | undefined }) {
  if (description === undefined || description === "") return null;
  return <figcaption className="mt-1 text-[11px] text-muted-foreground">{description}</figcaption>;
}

/** Lazy bounded thumbnail; click opens the full asset in a new tab. */
export function ArtifactImageViewer({
  artifact,
}: {
  readonly artifact: WorkflowTicketArtifactView;
}) {
  return (
    <figure className="m-0">
      <a href={artifact.url} target="_blank" rel="noopener noreferrer">
        <img
          src={artifact.url}
          alt={artifact.description ?? artifact.name}
          loading="lazy"
          className="max-h-64 max-w-full rounded-sm border border-border/60"
        />
      </a>
      <ArtifactCaption description={artifact.description} />
    </figure>
  );
}

export function ArtifactVideoViewer({
  artifact,
}: {
  readonly artifact: WorkflowTicketArtifactView;
}) {
  return (
    <figure className="m-0">
      {/* eslint-disable-next-line jsx-a11y/media-has-caption -- pipeline recordings have no track files */}
      <video
        src={artifact.url}
        controls
        preload="metadata"
        className="max-h-64 max-w-full rounded-sm border border-border/60"
      />
      <ArtifactCaption description={artifact.description} />
    </figure>
  );
}

const PRE_CLASS =
  "max-h-72 overflow-auto p-2 text-[11px] leading-4 whitespace-pre-wrap text-muted-foreground";

/** The legacy scratch listing (old <pre> viewer), unchanged styling. */
export function ScratchFileList({
  files,
}: {
  readonly files: ReadonlyArray<WorkflowTicketArtifact>;
}) {
  if (files.length === 0) {
    return <p className="text-xs text-muted-foreground">No working files.</p>;
  }
  return (
    <div className="space-y-2">
      {files.map((file) => (
        <details key={file.name} className="rounded-md border border-border/60 bg-background/70">
          <summary className="cursor-pointer px-2 py-1.5 text-xs font-medium text-foreground select-none">
            {file.name}
            {file.truncated === true ? (
              <span className="ml-2 font-normal text-muted-foreground">(truncated)</span>
            ) : null}
          </summary>
          <pre className={`border-t border-border/60 ${PRE_CLASS}`}>{file.content}</pre>
        </details>
      ))}
    </div>
  );
}

type ArtifactFetchState =
  | { readonly status: "idle" }
  | { readonly status: "loading" }
  | { readonly status: "loaded"; readonly content: string }
  | { readonly status: "error"; readonly message: string };

/**
 * One expandable markdown/text row. Inline content renders immediately;
 * omitted/truncated content fetches the full document via
 * `readTicketArtifact` when the row is first expanded.
 */
function TextualArtifactRow({
  api,
  ticketId,
  artifact,
  now,
}: {
  readonly api: EnvironmentApi;
  readonly ticketId: string;
  readonly artifact: WorkflowTicketArtifactView;
  readonly now: number;
}) {
  const [fetched, setFetched] = useState<ArtifactFetchState>({ status: "idle" });
  const [showRaw, setShowRaw] = useState(false);
  const contentState = contentStateFor(artifact);
  const isMarkdown = rendererForKind(artifact.kind) === "markdown";

  const loadFull = async () => {
    setFetched({ status: "loading" });
    try {
      const result = await api.workflow.readTicketArtifact({
        ticketId: TicketId.make(ticketId),
        artifactId: artifact.artifactId,
      });
      setFetched({ status: "loaded", content: result.content });
    } catch (cause) {
      setFetched({
        status: "error",
        message: cause instanceof Error ? cause.message : "Failed to read artifact.",
      });
    }
  };

  const content =
    fetched.status === "loaded"
      ? fetched.content
      : contentState.status === "inline"
        ? contentState.content
        : contentState.status === "needs-fetch"
          ? contentState.preview
          : undefined;

  return (
    <details
      className="rounded-md border border-border/60 bg-background/70"
      onToggle={(event) => {
        if (
          (event.currentTarget as HTMLDetailsElement).open &&
          needsFetchOnExpand(artifact) &&
          // Re-expanding after a failed fetch retries; only an in-flight or
          // successful load is final.
          (fetched.status === "idle" || fetched.status === "error")
        ) {
          void loadFull();
        }
      }}
    >
      <summary className="flex cursor-pointer items-center px-2 py-1.5 select-none">
        <ArtifactRowHeader artifact={artifact} now={now} />
      </summary>
      <div className="border-t border-border/60">
        {isMarkdown ? (
          <div className="flex justify-end px-2 pt-1.5">
            <button
              type="button"
              className="cursor-pointer rounded-sm border border-border/60 px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground hover:text-foreground"
              onClick={() => setShowRaw((previous) => !previous)}
            >
              {showRaw ? "Rendered" : "Raw"}
            </button>
          </div>
        ) : null}
        {fetched.status === "loading" ? (
          <p className="px-2 py-1.5 text-xs text-muted-foreground">Loading…</p>
        ) : null}
        {fetched.status === "error" ? (
          <p className="px-2 py-1.5 text-xs text-destructive-foreground" role="alert">
            {fetched.message}
          </p>
        ) : null}
        {content !== undefined ? (
          isMarkdown && !showRaw ? (
            <div className="p-2">
              <ChatMarkdown text={content} cwd={undefined} className="text-sm leading-5" />
            </div>
          ) : (
            <pre className={PRE_CLASS}>{content}</pre>
          )
        ) : null}
        {content !== undefined &&
        fetched.status !== "loaded" &&
        artifact.contentTruncated === true ? (
          <p className="px-2 pb-1.5 text-[10px] text-muted-foreground italic">
            showing a truncated preview
          </p>
        ) : null}
      </div>
    </details>
  );
}

function ArtifactRow({
  api,
  ticketId,
  artifact,
  now,
}: {
  readonly api: EnvironmentApi;
  readonly ticketId: string;
  readonly artifact: WorkflowTicketArtifactView;
  readonly now: number;
}) {
  const renderer = rendererForKind(artifact.kind);

  if (artifact.contentUnavailable === true) {
    return (
      <div className="rounded-md border border-border/60 bg-background/70 px-2 py-1.5">
        <div className="flex items-center">
          <ArtifactRowHeader artifact={artifact} now={now} />
        </div>
        <ArtifactUnavailableNotice />
      </div>
    );
  }

  if (renderer === "html-link") {
    return (
      <div className="flex items-center gap-2 rounded-md border border-border/60 bg-background/70 px-2 py-1.5">
        <ArtifactRowHeader artifact={artifact} now={now} />
        <ArtifactOpenInBrowser url={artifact.url} />
      </div>
    );
  }

  if (renderer === "image" || renderer === "video") {
    return (
      <details className="rounded-md border border-border/60 bg-background/70">
        <summary className="flex cursor-pointer items-center px-2 py-1.5 select-none">
          <ArtifactRowHeader artifact={artifact} now={now} />
        </summary>
        <div className="border-t border-border/60 p-2">
          {renderer === "image" ? (
            <ArtifactImageViewer artifact={artifact} />
          ) : (
            <ArtifactVideoViewer artifact={artifact} />
          )}
        </div>
      </details>
    );
  }

  return <TextualArtifactRow api={api} ticketId={ticketId} artifact={artifact} now={now} />;
}

/**
 * Split out so the minute tick only exists while the section is open —
 * the collapsed header renders no ages and should not re-render on a
 * timer. (Same pattern as NeedsYouTicketList.)
 */
function ArtifactList({
  api,
  ticketId,
  result,
}: {
  readonly api: EnvironmentApi;
  readonly ticketId: string;
  readonly result: WorkflowTicketArtifactsResult;
}) {
  const now = useNowTick(60_000);
  const artifacts = artifactsInServerOrder(result);
  return (
    <>
      {artifacts.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          No artifacts yet — pipeline steps write plans and reviews here.
        </p>
      ) : null}
      {artifacts.map((artifact) => (
        <ArtifactRow
          key={artifact.artifactId}
          api={api}
          ticketId={ticketId}
          artifact={artifact}
          now={now}
        />
      ))}
      {result.scratch.length > 0 ? (
        <details className="rounded-md border border-border/60 bg-background/70">
          <summary className="cursor-pointer px-2 py-1.5 text-xs font-medium text-foreground select-none">
            Working files (worktree)
            <span className="ml-2 font-normal text-muted-foreground">{result.scratch.length}</span>
          </summary>
          <div className="border-t border-border/60 p-2">
            <ScratchFileList files={result.scratch} />
          </div>
        </details>
      ) : null}
    </>
  );
}

/**
 * The ticket's case file: durable artifacts the pipeline published under
 * artifacts/, loaded lazily when the section is opened. Every open
 * refetches so signed asset URLs stay fresh.
 */
export function TicketArtifacts({
  api,
  ticketId,
}: {
  readonly api: EnvironmentApi | null | undefined;
  readonly ticketId: string;
}) {
  const [result, setResult] = useState<WorkflowTicketArtifactsResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const load = async () => {
    if (!api || loading) {
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const next = await api.workflow.listTicketArtifacts({
        ticketId: TicketId.make(ticketId),
      });
      setResult(next);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Failed to load artifacts.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <section className="shrink-0 rounded-md border border-border/70 bg-card/35 p-3">
      <details
        onToggle={(event) => {
          if ((event.currentTarget as HTMLDetailsElement).open) {
            void load();
          }
        }}
      >
        <summary className="cursor-pointer text-sm font-medium text-foreground select-none">
          Artifacts
          {result !== null ? (
            <span className="ml-2 text-xs font-normal text-muted-foreground">
              {result.artifacts.length}
            </span>
          ) : null}
        </summary>
        <div className="mt-2 space-y-2" data-testid="ticket-artifacts">
          {loading && result === null ? (
            <p className="text-xs text-muted-foreground">Loading…</p>
          ) : null}
          {error !== null ? (
            <p className="text-xs text-destructive-foreground" role="alert">
              {error}
            </p>
          ) : null}
          {result !== null && api ? (
            <ArtifactList api={api} ticketId={ticketId} result={result} />
          ) : null}
        </div>
      </details>
    </section>
  );
}
