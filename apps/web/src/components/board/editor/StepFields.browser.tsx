import "../../../index.css";

import {
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  LaneKey,
  ProviderDriverKind,
  ProviderInstanceId,
  StepKey,
  type ServerConfig,
  type ServerProvider,
  type WorkflowDefinitionEncoded,
} from "@t3tools/contracts";
import { createModelCapabilities } from "@t3tools/shared/model";
import { page } from "vite-plus/test/browser";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { render } from "vitest-browser-react";

import { createWorkflowEditorModel, type WorkflowEditorModel } from "~/workflow/editorModel";
import { AppAtomRegistryProvider } from "~/rpc/atomRegistry";
import { applyServerConfigEvent, resetServerStateForTests } from "~/rpc/serverState";

import { StepFields } from "./StepFields";

const claudeProvider: ServerProvider = {
  instanceId: ProviderInstanceId.make("claudeAgent"),
  driver: ProviderDriverKind.make("claudeAgent"),
  displayName: "Claude",
  enabled: true,
  installed: true,
  version: "1.0.0",
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-06-09T00:00:00.000Z",
  slashCommands: [],
  skills: [],
  models: [
    {
      slug: "claude-opus-4-6",
      name: "Claude Opus 4.6",
      isCustom: false,
      capabilities: createModelCapabilities({
        optionDescriptors: [
          {
            id: "effort",
            label: "Reasoning",
            type: "select",
            options: [
              { id: "low", label: "low" },
              { id: "medium", label: "medium", isDefault: true },
              { id: "high", label: "high" },
              { id: "max", label: "max" },
            ],
          },
        ],
      }),
    },
  ],
};

const serverConfig: ServerConfig = {
  environment: {
    environmentId: EnvironmentId.make("environment-local"),
    label: "Local environment",
    platform: { os: "darwin", arch: "arm64" },
    serverVersion: "0.0.0-test",
    capabilities: { repositoryIdentity: true },
  },
  auth: {
    policy: "loopback-browser",
    bootstrapMethods: ["one-time-token"],
    sessionMethods: ["browser-session-cookie", "bearer-access-token"],
    sessionCookieName: "t3_session",
  },
  cwd: "/tmp/workspace",
  keybindingsConfigPath: "/tmp/workspace/.config/keybindings.json",
  keybindings: [],
  issues: [],
  providers: [claudeProvider],
  availableEditors: ["cursor"],
  observability: {
    logsDirectoryPath: "/tmp/workspace/.config/logs",
    localTracingEnabled: true,
    otlpTracesEnabled: false,
    otlpMetricsEnabled: false,
  },
  settings: DEFAULT_SERVER_SETTINGS,
};

const laneKey = LaneKey.make("run");
const stepKey = StepKey.make("review");

const definition: WorkflowDefinitionEncoded = {
  name: "Delivery",
  lanes: [
    {
      key: laneKey,
      name: "Run",
      entry: "auto",
      pipeline: [
        {
          key: stepKey,
          type: "agent",
          agent: { instance: "claudeAgent", model: "claude-opus-4-6" },
          instruction: "Review the diff.",
        },
      ],
    },
  ],
};

const agentStep = definition.lanes[0]!.pipeline![0]!;

function seedProviders() {
  applyServerConfigEvent({ version: 1, type: "snapshot", config: serverConfig });
}

function renderStepFields(
  onMutate: (mutate: unknown) => void,
  options: { disabled?: boolean } = {},
) {
  return render(
    <AppAtomRegistryProvider>
      <StepFields
        laneKey={String(laneKey)}
        lanes={definition.lanes}
        step={agentStep}
        disabled={options.disabled ?? false}
        onMutate={onMutate}
      />
    </AppAtomRegistryProvider>,
  );
}

function findEffortTrigger() {
  return Array.from(document.querySelectorAll("button")).find((button) =>
    /medium/i.test(button.textContent ?? ""),
  );
}

describe("StepFields agent pickers", () => {
  beforeEach(() => {
    resetServerStateForTests();
    seedProviders();
  });

  afterEach(() => {
    resetServerStateForTests();
  });

  it("renders the provider/model picker and the effort picker for an agent step", async () => {
    const onMutate = vi.fn();
    renderStepFields(onMutate);

    await vi.waitFor(() => {
      const text = document.body.textContent ?? "";
      expect(text).toContain("Claude Opus 4.6");
      // The effort/traits trigger shows the current (default) reasoning value.
      expect(text.toLowerCase()).toContain("medium");
    });
  });

  it("writes the selected effort into the step's agent options", async () => {
    const onMutate = vi.fn();
    renderStepFields(onMutate);

    await page.getByRole("button", { name: /medium/i }).click();
    await page.getByRole("menuitemradio", { name: "high" }).click();

    await vi.waitFor(() => {
      expect(onMutate).toHaveBeenCalled();
    });

    const mutate = onMutate.mock.calls.at(-1)?.[0] as (
      m: WorkflowEditorModel,
    ) => WorkflowEditorModel;
    const next = mutate(createWorkflowEditorModel(definition));
    const nextStep = next.definition.lanes[0]?.pipeline?.[0];
    const options = nextStep?.type === "agent" ? nextStep.agent.options : undefined;
    expect(options).toContainEqual({ id: "effort", value: "high" });
  });

  it("disables the effort picker while the editor is busy", async () => {
    const onMutate = vi.fn();
    renderStepFields(onMutate, { disabled: true });

    await vi.waitFor(() => {
      const effortTrigger = findEffortTrigger();
      expect(effortTrigger).toBeTruthy();
      expect(effortTrigger?.disabled).toBe(true);
    });
  });
});

describe("StepFields pullRequest step", () => {
  const prOpenDefinition: WorkflowDefinitionEncoded = {
    name: "Delivery",
    lanes: [
      {
        key: laneKey,
        name: "Run",
        entry: "auto",
        pipeline: [
          {
            key: stepKey,
            type: "pullRequest",
            action: "open",
          },
        ],
      },
    ],
  };

  const prOpenStep = prOpenDefinition.lanes[0]!.pipeline![0]!;

  it("renders base/draft/titleTemplate/bodyTemplate fields for action=open", async () => {
    const onMutate = vi.fn();
    render(
      <StepFields
        laneKey={String(laneKey)}
        lanes={prOpenDefinition.lanes}
        step={prOpenStep}
        disabled={false}
        onMutate={onMutate}
      />,
    );

    await vi.waitFor(() => {
      const text = document.body.textContent ?? "";
      expect(text).toContain("Base branch");
      expect(text).toContain("PR title template");
      expect(text).toContain("PR body template");
      expect(text).toContain("Draft pull request");
    });
  });

  it("writes base branch via updateStep", async () => {
    const onMutate = vi.fn();
    render(
      <StepFields
        laneKey={String(laneKey)}
        lanes={prOpenDefinition.lanes}
        step={prOpenStep}
        disabled={false}
        onMutate={onMutate}
      />,
    );

    await page
      .getByRole("textbox", { name: `Step ${String(stepKey)} base branch` })
      .fill("main");

    await vi.waitFor(() => {
      expect(onMutate).toHaveBeenCalled();
    });

    const mutate = onMutate.mock.calls.at(-1)?.[0] as (
      m: WorkflowEditorModel,
    ) => WorkflowEditorModel;
    const next = mutate(createWorkflowEditorModel(prOpenDefinition));
    const nextStep = next.definition.lanes[0]?.pipeline?.[0];
    expect(nextStep?.type === "pullRequest" ? nextStep.base : undefined).toBe("main");
  });

  it("switches to land action and emits the mutation", async () => {
    const onMutate = vi.fn();
    render(
      <StepFields
        laneKey={String(laneKey)}
        lanes={prOpenDefinition.lanes}
        step={prOpenStep}
        disabled={false}
        onMutate={onMutate}
      />,
    );

    await page
      .getByRole("combobox", { name: `Step ${String(stepKey)} action` })
      .selectOptions("land");

    await vi.waitFor(() => {
      expect(onMutate).toHaveBeenCalled();
    });

    const mutate = onMutate.mock.calls.at(-1)?.[0] as (
      m: WorkflowEditorModel,
    ) => WorkflowEditorModel;
    const next = mutate(createWorkflowEditorModel(prOpenDefinition));
    const nextStep = next.definition.lanes[0]?.pipeline?.[0];
    expect(nextStep?.type === "pullRequest" ? nextStep.action : undefined).toBe("land");
  });

  it("renders strategy/deleteBranch fields for action=land", async () => {
    const prLandDefinition: WorkflowDefinitionEncoded = {
      ...prOpenDefinition,
      lanes: [
        {
          ...prOpenDefinition.lanes[0]!,
          pipeline: [{ key: stepKey, type: "pullRequest", action: "land" }],
        },
      ],
    };
    const prLandStep = prLandDefinition.lanes[0]!.pipeline![0]!;
    const onMutate = vi.fn();
    render(
      <StepFields
        laneKey={String(laneKey)}
        lanes={prLandDefinition.lanes}
        step={prLandStep}
        disabled={false}
        onMutate={onMutate}
      />,
    );

    await vi.waitFor(() => {
      const text = document.body.textContent ?? "";
      expect(text).toContain("Merge strategy");
      expect(text).toContain("Delete branch after merge");
    });
  });
});

describe("StepFields retry controls", () => {
  beforeEach(() => {
    resetServerStateForTests();
    seedProviders();
  });

  afterEach(() => {
    resetServerStateForTests();
  });

  it("enables retry with a max attempt count", async () => {
    const onMutate = vi.fn();
    renderStepFields(onMutate);

    await page
      .getByRole("combobox", { name: `Retries for step ${String(stepKey)}` })
      .selectOptions("3");

    await vi.waitFor(() => {
      expect(onMutate).toHaveBeenCalled();
    });

    const mutate = onMutate.mock.calls.at(-1)?.[0] as (
      m: WorkflowEditorModel,
    ) => WorkflowEditorModel;
    const next = mutate(createWorkflowEditorModel(definition));
    const nextStep = next.definition.lanes[0]?.pipeline?.[0];
    expect(nextStep?.type === "agent" ? nextStep.retry : undefined).toEqual({ maxAttempts: 3 });
  });

  it("seeds escalation from the step's agent when toggled on", async () => {
    const retryDefinition: WorkflowDefinitionEncoded = {
      ...definition,
      lanes: [
        {
          ...definition.lanes[0]!,
          pipeline: [{ ...agentStep, retry: { maxAttempts: 2 } } as typeof agentStep],
        },
      ],
    };
    const retryStep = retryDefinition.lanes[0]!.pipeline![0]!;
    const onMutate = vi.fn();
    render(
      <AppAtomRegistryProvider>
        <StepFields
          laneKey={String(laneKey)}
          lanes={retryDefinition.lanes}
          step={retryStep}
          disabled={false}
          onMutate={onMutate}
        />
      </AppAtomRegistryProvider>,
    );

    await page
      .getByRole("checkbox", { name: `Escalate on retry for step ${String(stepKey)}` })
      .click();

    await vi.waitFor(() => {
      expect(onMutate).toHaveBeenCalled();
    });

    const mutate = onMutate.mock.calls.at(-1)?.[0] as (
      m: WorkflowEditorModel,
    ) => WorkflowEditorModel;
    const next = mutate(createWorkflowEditorModel(retryDefinition));
    const nextStep = next.definition.lanes[0]?.pipeline?.[0];
    expect(nextStep?.type === "agent" ? nextStep.retry : undefined).toEqual({
      maxAttempts: 2,
      escalate: { instance: "claudeAgent", model: "claude-opus-4-6" },
    });
  });

  it("shows the retry select on script steps", async () => {
    const scriptDefinition: WorkflowDefinitionEncoded = {
      ...definition,
      lanes: [
        {
          ...definition.lanes[0]!,
          pipeline: [{ key: stepKey, type: "script", run: "pnpm test" }],
        },
      ],
    };
    const scriptStep = scriptDefinition.lanes[0]!.pipeline![0]!;
    const onMutate = vi.fn();
    render(
      <AppAtomRegistryProvider>
        <StepFields
          laneKey={String(laneKey)}
          lanes={scriptDefinition.lanes}
          step={scriptStep}
          disabled={false}
          onMutate={onMutate}
        />
      </AppAtomRegistryProvider>,
    );

    await page
      .getByRole("combobox", { name: `Retries for step ${String(stepKey)}` })
      .selectOptions("2");

    await vi.waitFor(() => {
      expect(onMutate).toHaveBeenCalled();
    });

    const mutate = onMutate.mock.calls.at(-1)?.[0] as (
      m: WorkflowEditorModel,
    ) => WorkflowEditorModel;
    const next = mutate(createWorkflowEditorModel(scriptDefinition));
    const nextStep = next.definition.lanes[0]?.pipeline?.[0];
    expect(nextStep?.type === "script" ? nextStep.retry : undefined).toEqual({ maxAttempts: 2 });
  });
});
