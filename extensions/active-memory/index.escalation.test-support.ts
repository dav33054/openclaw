import type { ActiveMemoryEscalationProvider } from "openclaw/plugin-sdk/active-memory-escalation-runtime";
import { expect, it, vi } from "vitest";

type ActiveMemoryEscalationIntegrationTestHarness = {
  currentActiveMemoryConfig: () => Record<string, unknown>;
  expectEmbeddedChannel: (messageChannel: string, messageProvider?: string) => void;
  expectPrependContextContains: (result: unknown, text: string) => void;
  hasDebugLine: (needle: string) => boolean;
  hasInfoLine: (needle: string) => boolean;
  registerPluginConfig: (overrides: Record<string, unknown>) => void;
  runEmbeddedAgent: unknown;
  runPromptBuild: (
    event: Record<string, unknown>,
    context?: Record<string, unknown>,
  ) => Promise<unknown>;
  setEscalationProvider: (provider: ActiveMemoryEscalationProvider | undefined) => void;
  skippedRecallContext: string;
};

export function registerActiveMemoryEscalationIntegrationTests({
  currentActiveMemoryConfig,
  expectEmbeddedChannel,
  expectPrependContextContains,
  hasDebugLine,
  hasInfoLine,
  registerPluginConfig,
  runEmbeddedAgent,
  runPromptBuild,
  setEscalationProvider,
  skippedRecallContext,
}: ActiveMemoryEscalationIntegrationTestHarness): void {
  it("uses a configured escalation provider to recall an ordinary turn", async () => {
    const decide = vi.fn(async () => "recall" as const);
    setEscalationProvider({ id: "local-memory-intent", decide });
    registerPluginConfig({ mode: "escalate", escalationProvider: "local-memory-intent" });

    const result = await runPromptBuild(
      { prompt: "Continue with that" },
      {
        sessionKey: "agent:main:webchat:direct:operator",
        messageProvider: "webchat",
        channelId: "operator",
      },
    );

    expect(decide).toHaveBeenCalledOnce();
    expect(decide).toHaveBeenCalledWith({
      message: "Continue with that",
      searchQuery: "Continue with that",
      signal: expect.any(AbortSignal),
    });
    expect(runEmbeddedAgent).toHaveBeenCalledOnce();
    expectPrependContextContains(result, "lemon pepper wings");
  });

  it("passes only bounded normalized text to an escalation provider", async () => {
    const decide = vi.fn<ActiveMemoryEscalationProvider["decide"]>(async () => "skip" as const);
    setEscalationProvider({ id: "local-memory-intent", decide });
    registerPluginConfig({ mode: "escalate", escalationProvider: "local-memory-intent" });

    await runPromptBuild(
      { prompt: `  ${"context ".repeat(100)}  ` },
      {
        sessionKey: "agent:main:webchat:direct:operator",
        messageProvider: "webchat",
        channelId: "operator",
      },
    );

    const input = decide.mock.calls[0]?.[0];
    expect(input?.message.length).toBeGreaterThan(0);
    expect(input?.message.length).toBeLessThanOrEqual(480);
    expect(input?.searchQuery.length).toBeGreaterThan(0);
    expect(input?.searchQuery.length).toBeLessThanOrEqual(480);
    expect(input?.message).not.toContain("  ");
    expect(input?.searchQuery).not.toContain("  ");
  });

  it("uses a configured escalation provider to skip a built-in recall match", async () => {
    const decide = vi.fn(async () => "skip" as const);
    setEscalationProvider({ id: "local-memory-intent", decide });
    registerPluginConfig({ mode: "escalate", escalationProvider: "local-memory-intent" });

    const result = await runPromptBuild(
      { prompt: "What did we decide last time?" },
      {
        sessionKey: "agent:main:webchat:direct:operator",
        messageProvider: "webchat",
        channelId: "operator",
      },
    );

    expect(decide).toHaveBeenCalledOnce();
    expect(runEmbeddedAgent).not.toHaveBeenCalled();
    expectPrependContextContains(result, skippedRecallContext);
    expect(hasDebugLine("active-memory: recall skipped reason=provider-skip")).toBe(true);
  });

  it("keeps configured escalation provider ids on one log line", async () => {
    registerPluginConfig({
      mode: "escalate",
      escalationProvider: "missing-provider\nforged",
    });

    await runPromptBuild({ prompt: "Explain the current configuration" });

    expect(
      hasDebugLine(
        "active-memory: escalation provider unavailable id=missing-provider forged; using built-in matcher",
      ),
    ).toBe(true);
  });
}
