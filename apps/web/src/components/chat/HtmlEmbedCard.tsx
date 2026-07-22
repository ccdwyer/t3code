import { CodeIcon, GlobeIcon, Maximize2Icon, Minimize2Icon } from "lucide-react";
import type { EnvironmentId } from "@t3tools/contracts";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { Button } from "../ui/button";
import { useProjectFileQuery } from "../files/projectFilesQueryState";
import { cn } from "../../lib/utils";
import {
  HTML_EMBED_MAX_HEIGHT,
  HTML_EMBED_MIN_HEIGHT,
  HTML_EMBED_SANDBOX,
  buildHtmlEmbedSrcDoc,
  isHtmlEmbedHeightMessage,
  isMessageFromEmbed,
} from "../../markdown-html-embed";

type HtmlEmbedView = "preview" | "code";

/**
 * Renders a closed ```html fence as a live sandboxed embed with a
 * Preview/Code toggle. The fence HTML runs with scripts enabled but in an
 * opaque origin (no `allow-same-origin`), so it cannot reach the app's DOM,
 * cookies, or storage; outbound network stays available so embeds can load
 * CDN libraries (the content is model-authored, so this leaks nothing the
 * model does not already have). On desktop the embed inherits the app CSP,
 * which blocks external `<script src>` — self-contained embeds work
 * everywhere. The iframe stays mounted while the Code view is shown so embed
 * state survives toggling.
 */
export function HtmlEmbedCard({
  html,
  codeBlock,
  title,
}: {
  html: string;
  codeBlock: ReactNode;
  title?: string;
}) {
  const [view, setView] = useState<HtmlEmbedView>("preview");
  const [expanded, setExpanded] = useState(false);
  const [contentHeight, setContentHeight] = useState<number | null>(null);
  const [loaded, setLoaded] = useState(false);
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const srcDoc = useMemo(() => buildHtmlEmbedSrcDoc(html), [html]);

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (!isMessageFromEmbed(event.source, iframeRef.current?.contentWindow)) return;
      if (!isHtmlEmbedHeightMessage(event.data)) return;
      setContentHeight(event.data.height);
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);

  const measuredHeight = Math.max(contentHeight ?? HTML_EMBED_MIN_HEIGHT, HTML_EMBED_MIN_HEIGHT);
  const collapsedHeight = Math.min(measuredHeight, HTML_EMBED_MAX_HEIGHT);
  const canExpand = measuredHeight > HTML_EMBED_MAX_HEIGHT;
  const expandLabel = expanded ? "Collapse preview" : "Expand preview";

  return (
    <div className="chat-markdown-codeblock leading-snug" data-html-embed-view={view}>
      <div className="chat-markdown-codeblock-header select-none">
        <span className="chat-markdown-codeblock-title">
          <GlobeIcon className="size-3.5" />
          <span className="truncate">{title ?? "HTML preview"}</span>
        </span>
        <span className="flex items-center gap-0.5">
          {view === "preview" && canExpand ? (
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-xs"
                    className="chat-markdown-chrome-action"
                    aria-pressed={expanded}
                    onClick={() => setExpanded((value) => !value)}
                    aria-label={expandLabel}
                  />
                }
              >
                {expanded ? (
                  <Minimize2Icon className="size-3" />
                ) : (
                  <Maximize2Icon className="size-3" />
                )}
              </TooltipTrigger>
              <TooltipPopup side="top">{expandLabel}</TooltipPopup>
            </Tooltip>
          ) : null}
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  className="chat-markdown-chrome-action"
                  aria-pressed={view === "preview"}
                  onClick={() => setView("preview")}
                  aria-label="Show preview"
                />
              }
            >
              <GlobeIcon className="size-3" />
            </TooltipTrigger>
            <TooltipPopup side="top">Show preview</TooltipPopup>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  className="chat-markdown-chrome-action"
                  aria-pressed={view === "code"}
                  onClick={() => setView("code")}
                  aria-label="Show code"
                />
              }
            >
              <CodeIcon className="size-3" />
            </TooltipTrigger>
            <TooltipPopup side="top">Show code</TooltipPopup>
          </Tooltip>
        </span>
      </div>
      <div className="relative bg-background" hidden={view !== "preview"}>
        <iframe
          ref={iframeRef}
          sandbox={HTML_EMBED_SANDBOX}
          srcDoc={srcDoc}
          referrerPolicy="no-referrer"
          title="Interactive HTML preview"
          className="block w-full border-0"
          style={
            expanded ? { height: measuredHeight, maxHeight: "85vh" } : { height: collapsedHeight }
          }
          onLoad={() => setLoaded(true)}
        />
        {!loaded ? (
          <div className="absolute inset-0 flex items-center justify-center text-xs text-muted-foreground">
            Loading preview…
          </div>
        ) : null}
      </div>
      {view === "code" ? (
        <div
          className={cn(
            "[&_.chat-markdown-codeblock]:my-0 [&_.chat-markdown-codeblock]:rounded-none",
            "[&_.chat-markdown-codeblock]:border-0",
          )}
        >
          {codeBlock}
        </div>
      ) : null}
    </div>
  );
}

/**
 * Renders an ```html file=path fence: loads the referenced workspace file via
 * the projects.readFile RPC (≤1 MB, text only) and shows it in the same
 * sandboxed embed. The fence body is empty, so the Code view renders the
 * loaded file source instead — supplied by `renderCodeBlock` to reuse
 * ChatMarkdown's highlighted code-block chrome without a circular import.
 */
export function HtmlFileEmbedCard({
  environmentId,
  cwd,
  relativePath,
  renderCodeBlock,
}: {
  environmentId: EnvironmentId;
  cwd: string;
  relativePath: string;
  renderCodeBlock: (code: string) => ReactNode;
}) {
  const file = useProjectFileQuery(environmentId, cwd, relativePath);
  if (file.data == null) {
    return (
      <div className="chat-markdown-codeblock leading-snug" data-html-embed-file={relativePath}>
        <div className="chat-markdown-codeblock-header select-none">
          <span className="chat-markdown-codeblock-title">
            <GlobeIcon className="size-3.5" />
            <span className="truncate">{relativePath}</span>
          </span>
        </div>
        <div className="px-3 py-2 text-xs text-muted-foreground">
          {file.isPending ? "Loading document…" : (file.error ?? "Unable to load document.")}
        </div>
      </div>
    );
  }
  return (
    <HtmlEmbedCard
      html={file.data.contents}
      codeBlock={renderCodeBlock(file.data.contents)}
      title={relativePath}
    />
  );
}
