import { PluginId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { EMPTY_PLUGIN_UI_REGISTRY_SNAPSHOT } from "./PluginUiHost";
import {
  getPluginSidebarResetKeys,
  getVisiblePluginSidebarSections,
} from "./PluginSidebarSections";

describe("PluginSidebarSections", () => {
  it("renders no sidebar sections for the zero-plugin registry", () => {
    expect(getVisiblePluginSidebarSections(EMPTY_PLUGIN_UI_REGISTRY_SNAPSHOT)).toEqual([]);
  });

  it("returns registered sidebar sections in registry order", () => {
    const pluginId = PluginId.make("fixture-plugin");

    expect(
      getVisiblePluginSidebarSections({
        ...EMPTY_PLUGIN_UI_REGISTRY_SNAPSHOT,
        sidebarSections: [
          {
            pluginId,
            id: "main",
            title: "Fixture",
            render: () => null,
          },
        ],
      }),
    ).toEqual([
      {
        pluginId,
        id: "main",
        title: "Fixture",
        render: expect.any(Function),
      },
    ]);
  });

  it("changes the error-boundary reset key when the environment changes", () => {
    const render = () => null;
    const sections = [
      {
        pluginId: PluginId.make("fixture-plugin"),
        id: "main",
        title: "Fixture",
        render,
      },
    ];

    expect(getPluginSidebarResetKeys(sections, "environment-a")).toEqual([
      { render, environmentId: "environment-a" },
    ]);
    expect(getPluginSidebarResetKeys(sections, "environment-b")).toEqual([
      { render, environmentId: "environment-b" },
    ]);
  });
});
