import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { TrimmedNonEmptyString } from "./baseSchemas.ts";

// SourceId and WorkSourceProviderName are defined in workflow.ts (to avoid an
// import cycle: workSource.ts imports LaneKey from workflow.ts, so workflow.ts
// cannot import from workSource.ts). They are re-exported here so callers
// can import everything source-related from @t3tools/contracts/workSource.
export {
  SourceId,
  WorkSourceProviderName,
  WorkflowSourceConfig,
} from "./workflow.ts";

// PURE selector schemas — used by synchronous lint AND the providers AND the UI.
export const GithubSelector = Schema.Struct({
  owner: TrimmedNonEmptyString,
  repo: TrimmedNonEmptyString,
  labels: Schema.optional(Schema.Array(Schema.String)),
  assignee: Schema.optional(Schema.String),
  state: Schema.Literals(["all", "open"]).pipe(
    Schema.withDecodingDefault(Effect.succeed("all" as const)),
  ),
});
export type GithubSelector = typeof GithubSelector.Type;

export const AsanaSelector = Schema.Struct({
  projectGid: TrimmedNonEmptyString,
  sectionGid: Schema.optional(Schema.String),
  tagGid: Schema.optional(Schema.String),
  includeCompleted: Schema.Boolean.pipe(
    Schema.withDecodingDefault(Effect.succeed(true)),
  ),
});
export type AsanaSelector = typeof AsanaSelector.Type;

export const WorkSourceConnectionView = Schema.Struct({
  connectionRef: TrimmedNonEmptyString,
  provider: Schema.Literals(["github", "asana"]),
  displayName: TrimmedNonEmptyString,
});
export type WorkSourceConnectionView = typeof WorkSourceConnectionView.Type;
