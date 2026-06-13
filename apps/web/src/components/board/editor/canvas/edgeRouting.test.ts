import { describe, expect, it } from "vite-plus/test";

import { classifyEdge, edgeEndpointSides, routeEdge, type EdgeRect } from "./edgeRouting";

const rect = (x: number, y: number, width = 240, height = 140): EdgeRect => ({
  x,
  y,
  width,
  height,
});

const pathNumbers = (d: string): number[] => d.match(/-?\d+(?:\.\d+)?/g)?.map(Number) ?? [];

describe("classifyEdge", () => {
  it("classifies adjacent columns as forward", () => {
    expect(classifyEdge(rect(0, 0), rect(312, 0))).toEqual({ kind: "forward" });
  });

  it("classifies stacked lanes as vertical", () => {
    expect(classifyEdge(rect(0, 0), rect(0, 300))).toEqual({ kind: "vertical" });
  });

  it("routes multi-column spans through the bottom channel", () => {
    expect(classifyEdge(rect(0, 0), rect(936, 0))).toEqual({
      kind: "channel",
      channel: "bottom",
    });
  });

  it("routes back-edges through the top channel", () => {
    expect(classifyEdge(rect(936, 0), rect(0, 0))).toEqual({ kind: "channel", channel: "top" });
  });
});

describe("edgeEndpointSides", () => {
  it("maps forward and rightward channel edges to the same physical sides", () => {
    expect(edgeEndpointSides(rect(0, 0), rect(312, 0))).toEqual({
      source: "right",
      target: "left",
    });
    expect(edgeEndpointSides(rect(0, 0), rect(936, 100))).toEqual({
      source: "right",
      target: "left",
    });
  });

  it("maps back-edges and stacked lanes to their travel sides", () => {
    expect(edgeEndpointSides(rect(936, 0), rect(0, 0))).toEqual({
      source: "left",
      target: "right",
    });
    expect(edgeEndpointSides(rect(0, 0), rect(0, 300))).toEqual({
      source: "bottom",
      target: "top",
    });
  });

  it("separates a forward and a channel edge sharing the right side via shared slots", () => {
    const source = rect(0, 0);
    const forward = routeEdge({
      source,
      target: rect(312, 0),
      sourceSlot: 0,
      sourceCount: 2,
      targetSlot: 0,
      targetCount: 1,
      channelSlot: 0,
      laneBandTop: 0,
      laneBandBottom: 600,
    });
    const channel = routeEdge({
      source,
      target: rect(936, 0),
      sourceSlot: 1,
      sourceCount: 2,
      targetSlot: 0,
      targetCount: 1,
      channelSlot: 0,
      laneBandTop: 0,
      laneBandBottom: 600,
    });
    const forwardStartY = pathNumbers(forward.d)[1];
    const channelStartY = pathNumbers(channel.d)[1];
    expect(forwardStartY).not.toBe(channelStartY);
  });
});

describe("routeEdge", () => {
  it("keeps channel detours outside the lane band", () => {
    const canvasHeight = 600;
    const route = routeEdge({
      source: rect(0, 0),
      target: rect(936, 100),
      sourceSlot: 0,
      sourceCount: 1,
      targetSlot: 0,
      targetCount: 1,
      channelSlot: 0,
      laneBandTop: 0,
      laneBandBottom: canvasHeight,
    });
    const ys = pathNumbers(route.d).filter((_, index) => index % 2 === 1);
    expect(Math.max(...ys)).toBeGreaterThan(canvasHeight);
    expect(route.labelY).toBeGreaterThan(canvasHeight);
  });

  it("keeps top-channel back-edges above the lanes", () => {
    const route = routeEdge({
      source: rect(936, 0),
      target: rect(0, 0),
      sourceSlot: 0,
      sourceCount: 1,
      targetSlot: 0,
      targetCount: 1,
      channelSlot: 1,
      laneBandTop: 0,
      laneBandBottom: 600,
    });
    const ys = pathNumbers(route.d).filter((_, index) => index % 2 === 1);
    expect(Math.min(...ys)).toBeLessThan(0);
  });

  it("fans out parallel forward edges across distinct ports", () => {
    const shared = {
      source: rect(0, 0),
      target: rect(312, 0),
      targetSlot: 0,
      targetCount: 1,
      channelSlot: 0,
      laneBandTop: 0,
      laneBandBottom: 600,
    };
    const first = routeEdge({ ...shared, sourceSlot: 0, sourceCount: 2 });
    const second = routeEdge({ ...shared, sourceSlot: 1, sourceCount: 2 });
    const firstStartY = pathNumbers(first.d)[1];
    const secondStartY = pathNumbers(second.d)[1];
    expect(firstStartY).not.toBe(secondStartY);
  });

  it("connects stacked lanes bottom-to-top", () => {
    const route = routeEdge({
      source: rect(0, 0, 240, 140),
      target: rect(0, 300, 240, 140),
      sourceSlot: 0,
      sourceCount: 1,
      targetSlot: 0,
      targetCount: 1,
      channelSlot: 0,
      laneBandTop: 0,
      laneBandBottom: 600,
    });
    const numbers = pathNumbers(route.d);
    expect(numbers[1]).toBe(140);
    expect(numbers.at(-1)).toBe(300);
  });
});
