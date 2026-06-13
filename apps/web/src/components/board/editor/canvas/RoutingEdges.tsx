import type { WorkflowDefinitionEncoded } from "@t3tools/contracts";

import type { WorkflowEditorSelection } from "~/workflow/editorModel";

import { cn } from "~/lib/utils";

import type { CanvasLayout } from "./canvasLayout";
import { LANE_CARD_WIDTH } from "./canvasLayout";
import { classifyEdge, edgeEndpointSides, routeEdge, type EdgeRect } from "./edgeRouting";
import { routeDndId, ROUTE_KIND_LABEL_FILL_CLASS, ROUTE_KIND_STROKE_CLASS } from "./RoutingHandles";

type RouteKind = "success" | "failure" | "blocked";

export interface CanvasPoint {
  readonly x: number;
  readonly y: number;
}

export type CanvasAnchors = Readonly<Record<string, CanvasPoint>>;

interface RoutingEdge {
  readonly id: string;
  readonly testId: string;
  readonly label: string;
  readonly sourceLaneKey: string;
  readonly targetLaneKey: string;
  readonly sourceAnchorId: string;
  readonly targetAnchorId: string;
  readonly edgeKind: "step-on" | "lane-transition" | "lane-on" | "lane-action";
  readonly precedence: 1 | 2 | 3 | 4;
  readonly displayLabel: string;
  readonly routeKind: RouteKind | undefined;
  readonly dashed: boolean;
  readonly selfLoop: boolean;
  readonly selection: WorkflowEditorSelection;
}

const routeKinds = ["success", "failure", "blocked"] as const satisfies readonly RouteKind[];

// Browsers disagree on marker fill="context-stroke", so each edge color gets
// its own marker; currentColor inside a marker resolves against the marker's
// own class, not the referencing path.
const EDGE_ARROW_MARKERS = [
  { id: "workflow-edge-arrow-success", className: "text-success" },
  { id: "workflow-edge-arrow-failure", className: "text-destructive" },
  { id: "workflow-edge-arrow-blocked", className: "text-warning" },
  { id: "workflow-edge-arrow-action", className: "text-info" },
  { id: "workflow-edge-arrow-muted", className: "text-muted-foreground" },
] as const;

const edgeArrowMarkerId = (edge: {
  readonly edgeKind: RoutingEdge["edgeKind"];
  readonly routeKind: RouteKind | undefined;
}): string => {
  if (edge.edgeKind === "lane-action") {
    return "workflow-edge-arrow-action";
  }
  switch (edge.routeKind) {
    case "success":
      return "workflow-edge-arrow-success";
    case "failure":
      return "workflow-edge-arrow-failure";
    case "blocked":
      return "workflow-edge-arrow-blocked";
    default:
      return "workflow-edge-arrow-muted";
  }
};
type RoutingEdgeIdParts = readonly [string, ...string[]];

const routingEdgeId = (parts: RoutingEdgeIdParts): string =>
  routeDndId(["workflow-edge", ...parts] as [string, ...string[]]);

export const routingEdgeTestId = (parts: RoutingEdgeIdParts): string =>
  routeDndId(["workflow-edge-testid", ...parts] as [string, ...string[]]);

export function RoutingEdges({
  definition,
  layout,
  anchors,
  selection,
  onSelect,
}: {
  readonly definition: WorkflowDefinitionEncoded;
  readonly layout: CanvasLayout;
  readonly anchors: CanvasAnchors;
  readonly selection?: WorkflowEditorSelection | null | undefined;
  readonly onSelect: (selection: WorkflowEditorSelection) => void;
}) {
  const edges = [...deriveRoutingEdges(definition)].sort(
    (left, right) => right.precedence - left.precedence,
  );
  const canvasHeight = Math.max(layout.height, 1);
  const routes = computeEdgeRoutes(edges, layout, anchors);

  // With a lane selected, edges that neither leave nor enter it fade out so
  // the selected lane's wiring is traceable through the crowd. Focused edges
  // render last (on top) without affecting slot allocation above.
  const focusLaneKey = selection?.laneKey ?? null;
  const isFocused = (edge: RoutingEdge): boolean =>
    focusLaneKey === null ||
    edge.sourceLaneKey === focusLaneKey ||
    edge.targetLaneKey === focusLaneKey;
  const edgesWithLabelOffsets = [...withLabelOffsets(edges)].sort(
    (left, right) => Number(isFocused(left.edge)) - Number(isFocused(right.edge)),
  );

  return (
    <svg
      className="pointer-events-none absolute inset-0 overflow-visible"
      width={layout.width}
      height={canvasHeight}
      aria-hidden={false}
    >
      <defs>
        {EDGE_ARROW_MARKERS.map((marker) => (
          <marker
            key={marker.id}
            id={marker.id}
            viewBox="0 0 10 10"
            refX="9"
            refY="5"
            markerWidth="5"
            markerHeight="5"
            orient="auto-start-reverse"
            className={marker.className}
          >
            <path d="M 0 0 L 10 5 L 0 10 z" fill="currentColor" />
          </marker>
        ))}
      </defs>
      {edgesWithLabelOffsets.map(({ edge, labelOffsetY }) => {
        const route = routes.get(edge.id);
        if (!route) {
          return null;
        }

        const dimmed = !isFocused(edge);
        return (
          <g
            key={edge.id}
            data-dimmed={dimmed ? "true" : undefined}
            className={cn("transition-opacity duration-150", dimmed && "opacity-15")}
          >
            <path
              data-testid={edge.testId}
              data-edge-kind={edge.edgeKind}
              data-precedence={edge.precedence}
              data-self-loop={edge.selfLoop ? "true" : undefined}
              aria-label={edge.label}
              d={route.d}
              fill="none"
              stroke="currentColor"
              strokeWidth={2}
              markerEnd={`url(#${edgeArrowMarkerId(edge)})`}
              strokeDasharray={
                edge.edgeKind === "lane-action" ? "2 4" : edge.dashed ? "6 4" : undefined
              }
              className={cn(
                "pointer-events-auto",
                edge.edgeKind === "lane-action"
                  ? "text-info"
                  : edge.routeKind
                    ? ROUTE_KIND_STROKE_CLASS[edge.routeKind]
                    : "text-muted-foreground",
              )}
              style={{ pointerEvents: "stroke" }}
              onClick={(event) => {
                event.stopPropagation();
                onSelect(edge.selection);
              }}
            />
            <text
              x={route.labelX}
              y={route.labelY + labelOffsetY}
              textAnchor="middle"
              className={cn(
                "pointer-events-none text-[10px] font-medium",
                edge.edgeKind === "lane-action"
                  ? "fill-info"
                  : edge.routeKind
                    ? ROUTE_KIND_LABEL_FILL_CLASS[edge.routeKind]
                    : "fill-muted-foreground",
              )}
            >
              {edge.displayLabel}
            </text>
          </g>
        );
      })}
    </svg>
  );
}

function laneRectFromLayout(layout: CanvasLayout, laneKey: string): EdgeRect | null {
  const lane = layout.lanes.find((candidate) => candidate.laneKey === laneKey);
  if (!lane) {
    return null;
  }
  return { x: lane.x, y: lane.y, width: lane.width, height: lane.estimatedHeight };
}

interface EdgeRoute {
  readonly d: string;
  readonly labelX: number;
  readonly labelY: number;
}

// Ports are chosen from lane geometry (which sides actually face each other)
// rather than fixed handle positions, and long spans / back-edges detour
// through the clear corridors above and below the lane grid so they never
// cut underneath intermediate cards.
function computeEdgeRoutes(
  edges: ReadonlyArray<RoutingEdge>,
  layout: CanvasLayout,
  anchors: CanvasAnchors,
): ReadonlyMap<string, EdgeRoute> {
  interface PlannedEdge {
    readonly edge: RoutingEdge;
    readonly source: EdgeRect;
    readonly target: EdgeRect;
    readonly sourceSideKey: string;
    readonly targetSideKey: string;
    readonly channelKey: string | null;
  }

  const planned: PlannedEdge[] = [];
  const routes = new Map<string, EdgeRoute>();

  for (const edge of edges) {
    if (edge.selfLoop) {
      const source = anchorPoint(
        edge.sourceAnchorId,
        edge.sourceLaneKey,
        layout,
        anchors,
        "source",
      );
      const target = anchorPoint(
        edge.targetAnchorId,
        edge.targetLaneKey,
        layout,
        anchors,
        "target",
      );
      const midpoint = { x: source.x + 52, y: Math.min(source.y, target.y) - 42 };
      routes.set(edge.id, {
        d: selfLoopPath(source, target),
        labelX: midpoint.x,
        labelY: midpoint.y,
      });
      continue;
    }

    const source = laneRectFromLayout(layout, edge.sourceLaneKey);
    const target = laneRectFromLayout(layout, edge.targetLaneKey);
    if (!source || !target) {
      continue;
    }
    const geometry = classifyEdge(source, target);
    const channelKey = geometry.kind === "channel" ? geometry.channel : null;
    // Slots are allocated per physical card side so edges of different kinds
    // (forward vs channel vs action) never claim the same anchor point.
    const sides = edgeEndpointSides(source, target);
    planned.push({
      edge,
      source,
      target,
      sourceSideKey: `${edge.sourceLaneKey}:${sides.source}`,
      targetSideKey: `${edge.targetLaneKey}:${sides.target}`,
      channelKey,
    });
  }

  const sideCounts = new Map<string, number>();
  for (const plan of planned) {
    sideCounts.set(plan.sourceSideKey, (sideCounts.get(plan.sourceSideKey) ?? 0) + 1);
    sideCounts.set(plan.targetSideKey, (sideCounts.get(plan.targetSideKey) ?? 0) + 1);
  }

  const sideSlots = new Map<string, number>();
  const channelSlots = new Map<string, number>();
  const takeSlot = (map: Map<string, number>, key: string): number => {
    const slot = map.get(key) ?? 0;
    map.set(key, slot + 1);
    return slot;
  };

  for (const plan of planned) {
    const route = routeEdge({
      source: plan.source,
      target: plan.target,
      sourceSlot: takeSlot(sideSlots, plan.sourceSideKey),
      sourceCount: sideCounts.get(plan.sourceSideKey) ?? 1,
      targetSlot: takeSlot(sideSlots, plan.targetSideKey),
      targetCount: sideCounts.get(plan.targetSideKey) ?? 1,
      channelSlot: plan.channelKey === null ? 0 : takeSlot(channelSlots, plan.channelKey),
      laneBandTop: layout.laneBandTop,
      laneBandBottom: layout.laneBandBottom,
    });
    routes.set(plan.edge.id, { d: route.d, labelX: route.labelX, labelY: route.labelY });
  }

  return routes;
}

export function deriveRoutingEdges(
  definition: WorkflowDefinitionEncoded,
): ReadonlyArray<RoutingEdge> {
  const laneNames = new Map(definition.lanes.map((lane) => [String(lane.key), lane.name]));
  const edges: RoutingEdge[] = [];

  for (const lane of definition.lanes) {
    const laneKey = String(lane.key);
    for (const step of lane.pipeline ?? []) {
      const stepKey = String(step.key);
      for (const kind of routeKinds) {
        const targetLaneKey = step.on?.[kind];
        if (!targetLaneKey || !laneNames.has(String(targetLaneKey))) {
          continue;
        }
        const targetKey = String(targetLaneKey);
        edges.push({
          id: routingEdgeId(["step-on", laneKey, stepKey, kind, targetKey]),
          testId: routingEdgeTestId(["step-on", laneKey, stepKey, kind, targetKey]),
          label: `Step ${stepKey} ${kind} route from ${lane.name} to ${laneNames.get(targetKey)}`,
          sourceLaneKey: laneKey,
          targetLaneKey: targetKey,
          sourceAnchorId: `step-${laneKey}-${stepKey}-on-${kind}`,
          targetAnchorId: `lane-${targetKey}-target`,
          edgeKind: "step-on",
          precedence: 1,
          displayLabel: kind,
          routeKind: kind,
          dashed: false,
          selfLoop: laneKey === targetKey,
          selection: { kind: "step", laneKey, stepKey },
        });
      }
    }

    for (const [index, transition] of (lane.transitions ?? []).entries()) {
      const targetKey = String(transition.to);
      if (!laneNames.has(targetKey)) {
        continue;
      }
      edges.push({
        id: routingEdgeId(["transition", laneKey, String(index), targetKey]),
        testId: routingEdgeTestId(["transition", laneKey, String(index), targetKey]),
        label: `Transition ${index + 1} from ${lane.name} to ${laneNames.get(targetKey)}`,
        sourceLaneKey: laneKey,
        targetLaneKey: targetKey,
        sourceAnchorId: `lane-${laneKey}-on-success`,
        targetAnchorId: `lane-${targetKey}-target`,
        edgeKind: "lane-transition",
        precedence: 2,
        displayLabel: `#${index + 1}`,
        routeKind: undefined,
        dashed: false,
        selfLoop: laneKey === targetKey,
        selection: {
          kind: "transition",
          laneKey,
          index,
        },
      });
    }

    for (const [index, action] of (lane.actions ?? []).entries()) {
      const targetKey = String(action.to);
      if (!laneNames.has(targetKey)) {
        continue;
      }
      edges.push({
        id: routingEdgeId(["lane-action", laneKey, String(index), targetKey]),
        testId: routingEdgeTestId(["lane-action", laneKey, String(index), targetKey]),
        label: `Action "${action.label}" from ${lane.name} to ${laneNames.get(targetKey)}`,
        sourceLaneKey: laneKey,
        targetLaneKey: targetKey,
        sourceAnchorId: `lane-${laneKey}-action-${index}`,
        targetAnchorId: `lane-${targetKey}-target`,
        edgeKind: "lane-action",
        precedence: 4,
        displayLabel: action.label,
        routeKind: undefined,
        dashed: false,
        selfLoop: laneKey === targetKey,
        selection: { kind: "lane", laneKey },
      });
    }

    for (const kind of routeKinds) {
      const targetLaneKey = lane.on?.[kind];
      if (!targetLaneKey || !laneNames.has(String(targetLaneKey))) {
        continue;
      }
      const targetKey = String(targetLaneKey);
      edges.push({
        id: routingEdgeId(["lane-on", laneKey, kind, targetKey]),
        testId: routingEdgeTestId(["lane-on", laneKey, kind, targetKey]),
        label: `Lane ${lane.name} ${kind} fallback route to ${laneNames.get(targetKey)}`,
        sourceLaneKey: laneKey,
        targetLaneKey: targetKey,
        sourceAnchorId: `lane-${laneKey}-on-${kind}`,
        targetAnchorId: `lane-${targetKey}-target`,
        edgeKind: "lane-on",
        precedence: 3,
        displayLabel: kind,
        routeKind: kind,
        dashed: true,
        selfLoop: laneKey === targetKey,
        selection: { kind: "lane", laneKey },
      });
    }
  }

  return edges;
}

function withLabelOffsets(
  edges: ReadonlyArray<RoutingEdge>,
): ReadonlyArray<{ readonly edge: RoutingEdge; readonly labelOffsetY: number }> {
  const groupCounts = new Map<string, number>();
  for (const edge of edges) {
    const key = edgeLabelGroupKey(edge);
    groupCounts.set(key, (groupCounts.get(key) ?? 0) + 1);
  }

  const groupSlots = new Map<string, number>();
  return edges.map((edge) => {
    const key = edgeLabelGroupKey(edge);
    const slot = groupSlots.get(key) ?? 0;
    groupSlots.set(key, slot + 1);
    const groupSize = groupCounts.get(key) ?? 1;
    return { edge, labelOffsetY: (slot - (groupSize - 1) / 2) * 12 };
  });
}

function edgeLabelGroupKey(edge: RoutingEdge): string {
  return `${edge.sourceAnchorId}\0${edge.targetAnchorId}\0${edge.selfLoop}`;
}

function anchorPoint(
  anchorId: string,
  laneKey: string,
  layout: CanvasLayout,
  anchors: CanvasAnchors,
  role: "source" | "target",
): CanvasPoint {
  const measured = anchors[anchorId];
  if (measured) {
    return measured;
  }

  const laneLayout = layout.lanes.find((lane) => lane.laneKey === laneKey);
  if (!laneLayout) {
    return { x: 0, y: 0 };
  }

  if (role === "target") {
    return { x: laneLayout.x, y: laneLayout.y + laneLayout.estimatedHeight / 2 };
  }

  if (anchorId.includes("-action-")) {
    const actionIndex = Number(anchorId.split("-action-")[1] ?? "0");
    return {
      x: laneLayout.x + LANE_CARD_WIDTH,
      y: laneLayout.y + laneLayout.estimatedHeight - 18 - actionIndex * 12,
    };
  }
  if (anchorId.includes("-on-failure")) {
    return { x: laneLayout.x + LANE_CARD_WIDTH, y: laneLayout.y + 56 };
  }
  if (anchorId.includes("-on-blocked")) {
    return { x: laneLayout.x + LANE_CARD_WIDTH, y: laneLayout.y + 74 };
  }
  if (anchorId.startsWith("step-")) {
    return { x: laneLayout.x + LANE_CARD_WIDTH, y: laneLayout.y + 110 };
  }
  return { x: laneLayout.x + LANE_CARD_WIDTH, y: laneLayout.y + 38 };
}

function edgePath(source: CanvasPoint, target: CanvasPoint): string {
  const delta = Math.max(64, Math.abs(target.x - source.x) / 2);
  return `M ${source.x} ${source.y} C ${source.x + delta} ${source.y}, ${target.x - delta} ${target.y}, ${target.x} ${target.y}`;
}

function selfLoopPath(source: CanvasPoint, target: CanvasPoint): string {
  const loopRight = source.x + 92;
  const loopTop = Math.min(source.y, target.y) - 56;
  return `M ${source.x} ${source.y} C ${loopRight} ${source.y}, ${loopRight} ${loopTop}, ${source.x + 28} ${loopTop} C ${target.x - 52} ${loopTop}, ${target.x - 52} ${target.y}, ${target.x} ${target.y}`;
}
