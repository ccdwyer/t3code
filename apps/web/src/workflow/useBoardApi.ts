import { RegistryContext } from "@effect/atom-react";
import type {
  EnvironmentApi,
  EnvironmentId,
  OrchestrationSubscribeThreadInput,
  OrchestrationThreadStreamItem,
  TerminalHistoryAttachInput,
  TerminalHistoryAttachStreamEvent,
} from "@t3tools/contracts";
import { AsyncResult, type AtomRegistry } from "effect/unstable/reactivity";
import { useContext, useMemo } from "react";

import { environmentThreads } from "../state/threads";
import { terminalEnvironment } from "../state/terminal";
import { useWorkflowApi } from "./useWorkflowApi";

/**
 * Board-route `EnvironmentApi` facade. Extends `useWorkflowApi` (the `workflow.*`
 * bridge) with the two subscription members the board drawer panels depend on:
 *   - `orchestration.subscribeThread` → StepActivityFeed + AgentSessionDialog
 *   - `terminal.attachHistory`        → ScriptStepLogViewer
 *
 * Both bridge over the raw client-runtime stream atoms exactly like
 * `useWorkflowApi`'s `subscribeBoard` bridges over `workflowEnvironment.boardRaw`:
 * mount the raw atom, `registry.subscribe` to forward each success value to the
 * callback, and return a teardown that unsubscribes + unmounts. This is the
 * subscribe-while-mounted lifecycle the chat surface uses.
 *
 * The `as EnvironmentApi` cast is deliberate and documented: the board component
 * tree reads only these 3 of `EnvironmentApi`'s 11 keys (`workflow`,
 * `orchestration`, `terminal`), and every member supplied here is a REAL client
 * — nothing is stubbed. This is the single allowed cast in this module.
 */
export function useBoardApi(environmentId: EnvironmentId): EnvironmentApi {
  const workflow = useWorkflowApi(environmentId);
  const registry = useContext(RegistryContext);

  return useMemo<EnvironmentApi>(
    () =>
      ({
        workflow,
        orchestration: {
          subscribeThread: (
            input: OrchestrationSubscribeThreadInput,
            callback: (event: OrchestrationThreadStreamItem) => void,
            options?: { readonly onResubscribe?: () => void },
          ) => subscribeThreadRaw(registry, environmentId, input, callback, options),
        },
        terminal: {
          attachHistory: (
            input: TerminalHistoryAttachInput,
            callback: (event: TerminalHistoryAttachStreamEvent) => void,
            options?: { readonly onResubscribe?: () => void },
          ) => attachTerminalHistoryRaw(registry, environmentId, input, callback, options),
        },
      }) as EnvironmentApi,
    [workflow, registry, environmentId],
  );
}

/**
 * Bridge for `orchestration.subscribeThread`. Mounts the raw thread-stream atom
 * and forwards each emitted `OrchestrationThreadStreamItem` to the callback;
 * returns a teardown that unsubscribes then unmounts. Mirrors
 * `useWorkflowApi`'s `subscribeBoardRaw`.
 */
function subscribeThreadRaw(
  registry: AtomRegistry.AtomRegistry,
  environmentId: EnvironmentId,
  input: OrchestrationSubscribeThreadInput,
  callback: (event: OrchestrationThreadStreamItem) => void,
  _options?: { readonly onResubscribe?: () => void },
): () => void {
  const atom = environmentThreads.streamRaw({ environmentId, input });
  const unmount = registry.mount(atom);
  const unsubscribe = registry.subscribe(atom, (result) => {
    if (AsyncResult.isSuccess(result)) {
      callback(result.value);
    }
  });
  return () => {
    unsubscribe();
    unmount();
  };
}

/**
 * Bridge for `terminal.attachHistory`. Mounts the raw terminal-history stream
 * atom and forwards each emitted `TerminalHistoryAttachStreamEvent` to the
 * callback; returns a teardown that unsubscribes then unmounts.
 */
function attachTerminalHistoryRaw(
  registry: AtomRegistry.AtomRegistry,
  environmentId: EnvironmentId,
  input: TerminalHistoryAttachInput,
  callback: (event: TerminalHistoryAttachStreamEvent) => void,
  _options?: { readonly onResubscribe?: () => void },
): () => void {
  const atom = terminalEnvironment.attachHistory({ environmentId, input });
  const unmount = registry.mount(atom);
  const unsubscribe = registry.subscribe(atom, (result) => {
    if (AsyncResult.isSuccess(result)) {
      callback(result.value);
    }
  });
  return () => {
    unsubscribe();
    unmount();
  };
}
