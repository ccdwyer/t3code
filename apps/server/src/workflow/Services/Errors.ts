import * as Schema from "effect/Schema";

export class WorkflowEventStoreError extends Schema.TaggedErrorClass<WorkflowEventStoreError>()(
  "WorkflowEventStoreError",
  {
    message: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {}
