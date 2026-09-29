// Covers the sessions_spawn agentId schema description for the requester's
// resolved target policy (default, explicit allowlist, wildcard) and the
// separate ACP harness guidance shown when runtime="acp" is available.
import { afterEach, beforeAll, expect, it } from "vitest";
import { resolveSessionStorePathCore } from "../../config/sessions/paths.js";
import { upsertSessionEntryCore } from "../../config/sessions/session-accessor.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { createSessionsSpawnTool } from "./sessions-spawn-tool.js";

let acpRuntimeRegistry: typeof import("../../acp/runtime/registry.js");

beforeAll(async () => {
  acpRuntimeRegistry = await import("../../acp/runtime/registry.js");
});

afterEach(() => {
  acpRuntimeRegistry.testing.resetAcpRuntimeBackendsForTests();
});

function requireAgentIdDescription(tool: ReturnType<typeof createSessionsSpawnTool>): string {
  const schema = tool.parameters as { properties: Record<string, { description?: string }> };
  const description = schema.properties.agentId?.description;
  if (!description) {
    throw new Error("expected agentId schema property with a description");
  }
  return description;
}

it("describes the requester-only default target", () => {
  const tool = createSessionsSpawnTool({ agentSessionKey: "agent:main:main" });
  const description = requireAgentIdDescription(tool);
  expect(description).toContain("Only the requester agent is allowed");
  expect(description).toContain('Omit to keep the requester agent ("main")');
});

it("describes an explicit allowlist target", () => {
  const tool = createSessionsSpawnTool({
    agentSessionKey: "agent:main:main",
    config: {
      agents: {
        defaults: { subagents: { allowAgents: ["main", "reviewer"] } },
        list: [{ id: "main" }, { id: "reviewer" }],
      },
    },
  });
  const description = requireAgentIdDescription(tool);
  expect(description).toContain("Configured agent to target: main, reviewer");
});

it("describes a wildcard allowlist target", () => {
  const tool = createSessionsSpawnTool({
    agentSessionKey: "agent:main:main",
    config: {
      agents: {
        defaults: { subagents: { allowAgents: ["*"] } },
        list: [{ id: "main" }, { id: "reviewer" }],
      },
    },
  });
  const description = requireAgentIdDescription(tool);
  expect(description).toContain("any configured agent is allowed");
});

function registerStubAcpBackend() {
  acpRuntimeRegistry.registerAcpRuntimeBackend({
    id: "acpx",
    runtime: {
      ensureSession: async () => ({
        sessionKey: "agent:codex:acp:1",
        backend: "acpx",
        runtimeSessionName: "codex",
      }),
      async *runTurn() {},
      cancel: async () => {},
      close: async () => {},
    },
  });
}

it("requires an explicit agentId when requireAgentId is configured", () => {
  const tool = createSessionsSpawnTool({
    agentSessionKey: "agent:main:main",
    config: { agents: { defaults: { subagents: { requireAgentId: true } } } },
  });
  const description = requireAgentIdDescription(tool);
  expect(description).toContain('agentId is required; the requester agent is "main"');
  expect(description).not.toContain("Omit to keep");
});

it("describes both runtimes separately when ACP is available", () => {
  registerStubAcpBackend();
  const tool = createSessionsSpawnTool({
    agentSessionKey: "agent:main:main",
    config: { acp: { defaultAgent: "codex" } },
  });
  const description = requireAgentIdDescription(tool);
  expect(description).toContain('With runtime="subagent" (default):');
  expect(description).toContain("Only the requester agent is allowed");
  expect(description).toContain('With runtime="acp":');
  expect(description).toContain('Omit to use the configured ACP default ("codex")');
});

it("narrows ACP guidance to requester admission for a subagent requester", () => {
  registerStubAcpBackend();
  const config = {
    acp: { defaultAgent: "codex" },
    agents: {
      list: [{ id: "main", subagents: { allowAgents: ["codex"], requireAgentId: true } }],
    },
  };
  const subagent = requireAgentIdDescription(
    createSessionsSpawnTool({ agentSessionKey: "agent:main:subagent:child", config }),
  );
  expect(subagent).toContain(
    'With runtime="acp": ACP harness id from: codex. agentId is required.',
  );
  const main = requireAgentIdDescription(
    createSessionsSpawnTool({ agentSessionKey: "agent:main:main", config }),
  );
  expect(main).toContain('Omit to use the configured ACP default ("codex")');
});

it("narrows ACP guidance for requesters stored as subagents", async () => {
  registerStubAcpBackend();
  const config = {
    acp: { defaultAgent: "codex" },
    agents: {
      list: [{ id: "main", subagents: { allowAgents: ["codex"], requireAgentId: true } }],
    },
  };
  const describe = (agentSessionKey: string) =>
    requireAgentIdDescription(createSessionsSpawnTool({ agentSessionKey, config }));
  const storedSubagents = {
    "agent:main:acp:child": { spawnedBy: "agent:main:subagent:parent" },
    "agent:main:dashboard:child": { spawnedBy: "agent:main:subagent:parent", spawnDepth: 1 },
  };
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    for (const [sessionKey, envelope] of Object.entries(storedSubagents)) {
      expect(describe(sessionKey)).toContain('Omit to use the configured ACP default ("codex")');
      await upsertSessionEntryCore(
        {
          agentId: "main",
          storePath: resolveSessionStorePathCore(undefined, { agentId: "main" }),
          sessionKey,
        },
        { sessionId: sessionKey, updatedAt: 1, ...envelope },
      );
      expect(describe(sessionKey)).toContain(
        'With runtime="acp": ACP harness id from: codex. agentId is required.',
      );
    }
  });
});

it("names the Swarm collector default agent for collect=true", () => {
  const description = requireAgentIdDescription(
    createSessionsSpawnTool({
      agentSessionKey: "agent:main:main",
      config: {
        tools: { swarm: { defaultAgentId: "planner" } },
        agents: {
          defaults: { subagents: { allowAgents: ["main", "planner"] } },
          list: [{ id: "main" }, { id: "planner" }],
        },
      },
    }),
  );
  expect(description).toContain('Omit to keep the requester agent ("main")');
  expect(description).toContain(
    'With collect=true, omit to target tools.swarm.defaultAgentId ("planner")',
  );
});

it("omits the collector default when Swarm is disabled", () => {
  const description = requireAgentIdDescription(
    createSessionsSpawnTool({
      agentSessionKey: "agent:main:main",
      config: { tools: { swarm: { enabled: false, defaultAgentId: "planner" } } },
    }),
  );
  expect(description).not.toContain("collect=true");
});
