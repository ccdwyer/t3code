import * as Layer from "effect/Layer";
import { FetchHttpClient } from "effect/unstable/http";

import { ProjectionThreadActivityRepositoryLive } from "../persistence/Layers/ProjectionThreadActivities.ts";
import { ProjectionThreadMessageRepositoryLive } from "../persistence/Layers/ProjectionThreadMessages.ts";
import { ProjectionTurnRepositoryLive } from "../persistence/Layers/ProjectionTurns.ts";
import { ApprovalGateLive } from "./Layers/ApprovalGate.ts";
import { BoardDiscoveryLive } from "./Layers/BoardDiscovery.ts";
import { BoardRegistryLive } from "./Layers/BoardRegistry.ts";
import { CapturedStepOutputReaderLive } from "./Layers/CapturedStepOutputReader.ts";
import { DurableApprovalResumeLive } from "./Layers/DurableApprovalResume.ts";
import { ScriptCancelRegistryLive } from "./Layers/ScriptCancelRegistry.ts";
import { ScriptCommandRunnerLive } from "./Layers/ScriptCommandRunner.ts";
import { ScriptStepExecutorLive } from "./Layers/ScriptStepExecutor.ts";
import {
  ProviderDispatchOutboxLive,
  ProviderTurnPortLive,
} from "./Layers/ProviderDispatchOutbox.ts";
import { ProjectScriptTrustLive } from "./Layers/ProjectScriptTrust.ts";
import { ProviderResponsePortLive } from "./Layers/ProviderResponsePort.ts";
import { ProjectWorkspaceResolverLive } from "./Layers/ProjectWorkspaceResolver.ts";
import { PredicateEvaluatorLive } from "./Layers/PredicateEvaluator.ts";
import { RealStepExecutorLive, WorktreePortLive } from "./Layers/RealStepExecutor.ts";
import { SetupRunServiceLive, SetupTerminalPortLive } from "./Layers/SetupRunService.ts";
import { StepUsageReaderLive } from "./Layers/StepUsageReader.ts";
import { TicketCheckpointServiceLive } from "./Layers/TicketCheckpointService.ts";
import { MergeGitPortLive, TicketMergeServiceLive } from "./Layers/TicketMergeService.ts";
import { GitHubPortLive } from "./Layers/GitHubPort.ts";
import { TicketPullRequestServiceLive } from "./Layers/TicketPullRequestService.ts";
import { WorkflowThreadJanitorLive } from "./Layers/WorkflowThreadJanitor.ts";
import { WorkflowWebhookLive } from "./Layers/WorkflowWebhook.ts";
import { WorkflowWorktreeJanitorLive } from "./Layers/WorkflowWorktreeJanitor.ts";
import { TicketDiffQueryLive, WorktreeDiffPortLive } from "./Layers/TicketDiffQuery.ts";
import { TurnProjectionPortLive, TurnStateReaderLive } from "./Layers/TurnStateReader.ts";
import { WorkflowBoardEventsLive } from "./Layers/WorkflowBoardEvents.ts";
import { WorkflowBoardNotificationDispatcherLive } from "./Layers/WorkflowBoardNotificationDispatcher.ts";
import { WorkflowBoardNotificationRelayLive } from "./Layers/WorkflowBoardNotificationRelay.ts";
import { WorkflowBoardSaveLocksLive } from "./Layers/WorkflowBoardSaveLocks.ts";
import { WorkflowEngineLayer } from "./Layers/WorkflowEngine.ts";
import { WorkflowEventCommitterLive } from "./Layers/WorkflowEventCommitter.ts";
import {
  WorkflowFileLoaderLive,
  WorkflowFilePortLive,
  WorkflowProviderInstancePortLive,
} from "./Layers/WorkflowFileLoader.ts";
import { WorkflowGitHubPollerLive } from "./Layers/WorkflowGitHubPoller.ts";
import { WorkflowIdsLive } from "./Layers/WorkflowIds.ts";
import { WorkflowIntakeLive } from "./Layers/WorkflowIntake.ts";
import { WorkflowRecoveryLive } from "./Layers/WorkflowRecovery.ts";
import { WorkflowRoutingContextBuilderLive } from "./Layers/WorkflowRoutingContextBuilder.ts";
import { WorkflowTerminalRetentionSweeperLive } from "./Layers/WorkflowTerminalRetentionSweeper.ts";
import { AsanaProviderLive } from "./Layers/AsanaProvider.ts";
import { GithubIssuesProviderLive } from "./Layers/GithubIssuesProvider.ts";
import { WorkSourceConnectionStoreLive } from "./Layers/WorkSourceConnectionStore.ts";
import { WorkSourceProviderRegistryLive } from "./Layers/WorkSourceProviderRegistry.ts";
import { WorkflowSourceCommitterLive } from "./Layers/WorkflowSourceCommitter.ts";
import { WorkflowSourceSyncerLive } from "./Layers/WorkflowSourceSyncer.ts";
import { WorktreeLeaseServiceLive } from "./Layers/WorktreeLeaseService.ts";
import { WorkflowFoundationLive } from "./WorkflowFoundationLive.ts";

// PR steps run through the GitHub port. GitHubPortLive leaks GitHubCli +
// SourceControlProviderRegistry as runtime requirements (mirrors how
// MergeGitPort/WorktreePort leak the git driver stack), satisfied by the
// server's source-control wiring.
const StepExecutionLive = RealStepExecutorLive.pipe(
  Layer.provideMerge(TicketMergeServiceLive),
  Layer.provideMerge(TicketPullRequestServiceLive),
  Layer.provideMerge(GitHubPortLive),
);

const WorkflowRuntimeCoreBaseLive = Layer.mergeAll(
  WorkflowEngineLayer,
  WorkflowRecoveryLive.pipe(Layer.provideMerge(WorkflowEngineLayer)),
  WorkflowTerminalRetentionSweeperLive.pipe(Layer.provideMerge(WorkflowEngineLayer)),
  WorkflowGitHubPollerLive.pipe(Layer.provideMerge(WorkflowEngineLayer)),
).pipe(
  Layer.provideMerge(StepExecutionLive),
  Layer.provideMerge(CapturedStepOutputReaderLive),
  Layer.provideMerge(ScriptStepExecutorLive),
  Layer.provideMerge(ScriptCommandRunnerLive),
  Layer.provideMerge(ScriptCancelRegistryLive),
  Layer.provideMerge(ProjectScriptTrustLive),
  Layer.provideMerge(ProviderDispatchOutboxLive),
  Layer.provideMerge(TurnStateReaderLive),
  Layer.provideMerge(SetupRunServiceLive),
  Layer.provideMerge(WorktreeLeaseServiceLive),
  Layer.provideMerge(DurableApprovalResumeLive),
  Layer.provideMerge(WorkflowBoardEventsLive),
  Layer.provideMerge(WorkflowEventCommitterLive),
  Layer.provideMerge(WorkflowBoardSaveLocksLive),
  // BoardRegistry is also re-exported by WorkflowFoundationLive below; same module export → Effect memoizes one instance.
  Layer.provideMerge(BoardRegistryLive),
  Layer.provideMerge(PredicateEvaluatorLive),
  Layer.provideMerge(WorkflowRoutingContextBuilderLive),
  Layer.provideMerge(ApprovalGateLive),
  Layer.provideMerge(ProjectionTurnRepositoryLive),
  Layer.provideMerge(ProjectionThreadMessageRepositoryLive),
);

export const WorkflowRuntimeCoreLive = WorkflowRuntimeCoreBaseLive.pipe(
  Layer.provideMerge(WorkflowFoundationLive),
);

export const WorkflowRuntimeLive = WorkflowRuntimeCoreLive.pipe(
  Layer.provideMerge(WorkflowIdsLive),
  Layer.provideMerge(ProviderTurnPortLive),
  Layer.provideMerge(TurnProjectionPortLive),
  Layer.provideMerge(SetupTerminalPortLive),
  Layer.provideMerge(WorkflowWorktreeJanitorLive),
  Layer.provideMerge(WorkflowThreadJanitorLive),
  Layer.provideMerge(WorkflowWebhookLive),
  Layer.provideMerge(
    StepUsageReaderLive.pipe(Layer.provide(ProjectionThreadActivityRepositoryLive)),
  ),
  Layer.provideMerge(TicketCheckpointServiceLive),
  Layer.provideMerge(MergeGitPortLive),
  Layer.provideMerge(WorktreePortLive),
  Layer.provideMerge(ProviderResponsePortLive),
);

const WorkflowBoardDiscoverySupportLive = BoardDiscoveryLive.pipe(
  Layer.provideMerge(ProjectWorkspaceResolverLive),
  Layer.provideMerge(WorkflowFileLoaderLive),
  Layer.provideMerge(WorkflowBoardSaveLocksLive),
);

export const WorkflowRpcSupportLive = Layer.mergeAll(
  WorkflowFileLoaderLive,
  TicketDiffQueryLive,
  ProjectWorkspaceResolverLive,
  WorkflowBoardDiscoverySupportLive,
  WorkflowBoardSaveLocksLive,
).pipe(
  // BoardRegistry is also re-exported by WorkflowFoundationLive below; same module export → Effect memoizes one instance.
  Layer.provideMerge(BoardRegistryLive),
  Layer.provideMerge(WorkflowBoardEventsLive),
  Layer.provideMerge(WorkflowFoundationLive),
  Layer.provideMerge(WorkflowFilePortLive),
  Layer.provideMerge(WorkflowProviderInstancePortLive),
  Layer.provideMerge(WorktreeDiffPortLive),
);

// Board push-notification dispatcher + relay. The relay (HTTP publish client)
// depends on ServerSecretStore + ServerEnvironment + Crypto; the dispatcher
// depends on the relay + WorkflowReadModel + ServerEnvironment + SqlClient.
// WorkflowReadModel is provided inside WorkflowRuntimeLive (via
// WorkflowFoundationLive), so we provideMerge the dispatcher (with the relay
// merged in) over the runtime here; the remaining server-level requirements
// (ServerSecretStore, ServerEnvironment, Crypto, SqlClient) propagate upward
// and are satisfied by the server runtime composition in server.ts.
const WorkflowBoardNotificationLive = WorkflowBoardNotificationDispatcherLive.pipe(
  Layer.provideMerge(WorkflowBoardNotificationRelayLive),
);

// Work-source sync stack ("work arrives by itself").
//
// The two HTTP providers (GitHub Issues, Asana) require an HttpClient and the
// WorkSourceConnectionStore. We provide FetchHttpClient + the connection store
// to the provider registry so the registry's two provider tags resolve, then
// merge the connection store back out (it is also consumed by the ws.ts
// connection RPCs, so it must be visible at the runtime surface). The committer
// and syncer depend on engine/board-registry/save-locks/sql/ids — all provided
// by WorkflowRuntimeLive below — so those requirements propagate upward and are
// satisfied where WorkSourceLive is merged into the server runtime. Remaining
// server-level deps (SqlClient, ServerSecretStore) propagate to server.ts, the
// same way the notification dispatcher/relay deps do.
const WorkSourceProviderStackLive = WorkSourceProviderRegistryLive.pipe(
  Layer.provide(GithubIssuesProviderLive),
  Layer.provide(AsanaProviderLive),
  Layer.provide(FetchHttpClient.layer),
);

const WorkSourceLive = WorkflowSourceSyncerLive.pipe(
  // The syncer requires the committer + provider registry; provide (and
  // re-export, so both stay visible at the runtime surface) via provideMerge.
  Layer.provideMerge(WorkflowSourceCommitterLive),
  Layer.provideMerge(WorkSourceProviderStackLive),
  Layer.provideMerge(WorkSourceConnectionStoreLive),
);

export const WorkflowServerRuntimeLive = WorkflowIntakeLive.pipe(
  Layer.provideMerge(WorkflowRpcSupportLive),
  Layer.provideMerge(WorkflowBoardNotificationLive),
  Layer.provideMerge(WorkSourceLive),
  Layer.provideMerge(WorkflowRuntimeLive),
);
