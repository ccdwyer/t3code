import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Layer from "effect/Layer";
import { Atom } from "effect/unstable/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import { createTerminalEnvironmentAtoms } from "./terminal.ts";

describe("createTerminalEnvironmentAtoms", () => {
  it("exposes a stable per-session raw attachHistory stream atom family", () => {
    const runtime = Atom.runtime(Layer.empty) as unknown as Atom.AtomRuntime<
      EnvironmentRegistry,
      never
    >;
    const terminal = createTerminalEnvironmentAtoms(runtime);
    const environmentId = EnvironmentId.make("environment-1");
    const input = { threadId: "thread-1", terminalId: "terminal-1" };
    const atom = terminal.attachHistory({ environmentId, input });

    // Same environment + session → same atom (idle-TTL retention keyed on input).
    expect(terminal.attachHistory({ environmentId, input })).toBe(atom);
    // A different terminalId is a distinct session → distinct atom.
    expect(
      terminal.attachHistory({ environmentId, input: { ...input, terminalId: "terminal-2" } }),
    ).not.toBe(atom);
  });
});
