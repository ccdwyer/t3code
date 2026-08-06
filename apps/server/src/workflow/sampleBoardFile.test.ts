import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { WorkflowDefinition } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { lintWorkflowDefinition } from "./workflowFile.ts";

const decodeWorkflowDefinitionJson = Schema.decodeEffect(Schema.fromJsonString(WorkflowDefinition));

it.layer(NodeServices.layer)("sample delivery board", (it) => {
  it.effect("decodes and lints for the default codex provider", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const repoRoot = path.join(process.cwd(), "../..");
      // `.t3/` is gitignored developer state, so this board is absent on a fresh
      // clone and in CI. Validate it when present (it guards a real local board
      // against schema/lint drift) and skip otherwise rather than failing a
      // checkout that never had the file. The tracked example board below gives
      // this suite its clone-independent coverage.
      const boardPath = path.join(repoRoot, ".t3/boards/delivery.json");
      if (!(yield* fileSystem.exists(boardPath))) {
        return;
      }
      const raw = yield* fileSystem.readFileString(boardPath);
      const definition = yield* decodeWorkflowDefinitionJson(raw);
      const lintErrors = lintWorkflowDefinition(definition, {
        providerInstanceExists: (instanceId) => instanceId === "codex",
        instructionFileExists: () => true,
      });

      assert.equal(definition.name, "Standard delivery");
      assert.deepEqual(
        lintErrors.map((error) => error.code),
        [],
      );
    }),
  );
});

it.layer(NodeServices.layer)("github-flow example board", (it) => {
  it.effect("decodes and lints with no errors", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const repoRoot = path.join(process.cwd(), "../..");
      const raw = yield* fileSystem.readFileString(
        path.join(repoRoot, "docs/workflow-boards/github-flow-example.json"),
      );
      const definition = yield* decodeWorkflowDefinitionJson(raw);
      const lintErrors = lintWorkflowDefinition(definition, {
        providerInstanceExists: (instanceId) => instanceId === "codex",
        instructionFileExists: () => true,
      });

      assert.equal(definition.name, "GitHub flow");
      assert.deepEqual(
        lintErrors.map((error) => error.code),
        [],
      );
    }),
  );
});
