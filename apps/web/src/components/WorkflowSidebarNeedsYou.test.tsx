import { BoardId } from "@t3tools/contracts";
import type { WorkflowNeedsAttentionTicketView } from "@t3tools/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { NeedsYouTicketList, WorkflowSidebarNeedsYou } from "./WorkflowSidebarNeedsYou";

const ticket = (
  id: string,
  over: Partial<WorkflowNeedsAttentionTicketView> = {},
): WorkflowNeedsAttentionTicketView =>
  ({
    ticketId: id,
    boardId: BoardId.make("p__delivery"),
    boardName: "Delivery",
    title: `Ticket ${id}`,
    status: "blocked",
    currentLaneKey: "work",
    attentionKind: "blocked",
    attentionReason: "step failed",
    updatedAt: "2026-08-05T10:00:00Z",
    parkedAt: null,
    slaBreachedAt: null,
    slaBreachedReason: null,
    ...over,
  }) as WorkflowNeedsAttentionTicketView;

describe("WorkflowSidebarNeedsYou", () => {
  it("renders nothing when no tickets need attention", () => {
    const markup = renderToStaticMarkup(
      <WorkflowSidebarNeedsYou tickets={[]} onOpenTicket={() => {}} />,
    );
    expect(markup).toBe("");
  });

  it("renders the header with a total count, collapsed by default", () => {
    const markup = renderToStaticMarkup(
      <WorkflowSidebarNeedsYou tickets={[ticket("t1"), ticket("t2")]} onOpenTicket={() => {}} />,
    );
    expect(markup).toContain("Needs you");
    expect(markup).toContain('data-testid="sidebar-v2-needs-you-count"');
    expect(markup).toContain(">2<");
    // Collapsed: the list is not in the markup (static render has no effects).
    expect(markup).not.toContain("sidebar-v2-needs-you-list");
  });
});

describe("NeedsYouTicketList", () => {
  it("renders rows with board name, tone dot, age, focus ring, and overflow", () => {
    const markup = renderToStaticMarkup(
      <NeedsYouTicketList
        visible={[
          ticket("t1"),
          ticket("t2", {
            attentionKind: null,
            slaBreachedAt: "2026-08-05T09:00:00Z" as never,
          }),
        ]}
        hiddenCount={3}
        onOpenTicket={() => {}}
      />,
    );
    expect(markup).toContain("Delivery");
    expect(markup).toContain('data-testid="sidebar-v2-needs-you-ticket-t1"');
    expect(markup).toContain("focus-visible:ring-2");
    expect(markup).toContain("border-red");
    expect(markup).toContain("…and 3 more on their boards");
  });
});
