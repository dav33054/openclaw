import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import {
  getActivePluginRegistry,
  resetPluginRuntimeStateForTest,
  setActivePluginRegistry,
} from "../plugins/runtime.js";
import { registerAgentHarness } from "./harness/registry.js";
import type { AgentHarness } from "./harness/types.js";
import { resolveUtilityCompletionRuntimeForAgent } from "./utility-completion.js";

function config(utilityModelEntry?: { agentRuntime: { id: string } }): OpenClawConfig {
  return {
    agents: {
      defaults: {
        model: { primary: "anthropic/claude-opus-4-6" },
        utilityModel: "anthropic/claude-haiku-4-5",
        ...(utilityModelEntry
          ? { models: { "anthropic/claude-haiku-4-5": utilityModelEntry } }
          : {}),
      },
    },
  } as OpenClawConfig;
}

describe("resolveUtilityCompletionRuntimeForAgent", () => {
  it("reports the Claude CLI owner a utility model's runtime pin dispatches to", async () => {
    await expect(
      resolveUtilityCompletionRuntimeForAgent({
        cfg: config({ agentRuntime: { id: "claude-cli" } }),
        agentId: "main",
      }),
    ).resolves.toEqual({ id: "claude-cli", kind: "cli", label: "Claude CLI" });
  });

  it("reports the built-in HTTP runtime for a utility model without a CLI route", async () => {
    await expect(
      resolveUtilityCompletionRuntimeForAgent({ cfg: config(), agentId: "main" }),
    ).resolves.toEqual({ id: "openclaw", kind: "api", label: "OpenClaw Default" });
  });

  describe("with a plugin harness", () => {
    const originalPluginRegistry = getActivePluginRegistry();
    const harnessConfig = {
      agents: {
        defaults: {
          model: { primary: "openai/gpt-5.6-sol" },
          utilityModel: "openai/gpt-5.6-luna",
          models: { "openai/gpt-5.6-luna": { agentRuntime: { id: "route-test" } } },
        },
      },
    } as OpenClawConfig;
    const harness = (isolated: boolean): AgentHarness => ({
      id: "route-test",
      label: "Route Test",
      supports: () => ({ supported: true }),
      async runAttempt() {
        throw new Error("not used");
      },
      ...(isolated
        ? {
            async runIsolatedCompletionV2() {
              throw new Error("not used");
            },
          }
        : {}),
    });

    beforeEach(() => {
      setActivePluginRegistry(createEmptyPluginRegistry(), "utility-route-test", "default");
    });
    afterEach(() => {
      if (originalPluginRegistry) {
        setActivePluginRegistry(originalPluginRegistry, "utility-route-test-restore", "default");
        return;
      }
      resetPluginRuntimeStateForTest();
    });

    it("reports the harness with the label it declares", async () => {
      registerAgentHarness(harness(true));
      await expect(
        resolveUtilityCompletionRuntimeForAgent({ cfg: harnessConfig, agentId: "main" }),
      ).resolves.toEqual({ id: "route-test", kind: "harness", label: "Route Test" });
    });

    it("reports no route for a harness that cannot run isolated completions", async () => {
      registerAgentHarness(harness(false));
      await expect(
        resolveUtilityCompletionRuntimeForAgent({ cfg: harnessConfig, agentId: "main" }),
      ).resolves.toBeUndefined();
    });
  });
});
