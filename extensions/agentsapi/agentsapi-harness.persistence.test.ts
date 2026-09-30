import path from "node:path";
import type { Turn } from "openai/resources/beta/agents/sessions/turns";
import type { AgentHarnessAttemptParamsV2 } from "openclaw/plugin-sdk/agent-harness-runtime";
import { AuthStorage, ModelRegistry } from "openclaw/plugin-sdk/agent-sessions";
import type { OpenClawConfig, OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import type { PluginRuntime } from "openclaw/plugin-sdk/plugin-runtime";
import {
  createPluginStateKeyedStoreForTests,
  createPluginStateSyncKeyedStoreForTests,
  resetPluginStateStoreForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import { createPluginRuntimeMock } from "openclaw/plugin-sdk/plugin-test-runtime";
import { upsertSessionEntry } from "openclaw/plugin-sdk/session-store-runtime";
import { closeOpenClawStateDatabaseAsync } from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { withOpenClawTestState } from "openclaw/plugin-sdk/test-state";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { AgentsApiBinding } from "./agentsapi-bindings.js";
import { AgentsApiClient } from "./agentsapi-client.js";
import type { AgentsApiExecutorController } from "./agentsapi-environment.js";
import { createAgentsApiHarness } from "./agentsapi-harness.js";
import plugin from "./index.js";

const { createSession } = vi.hoisted(() => ({
  createSession: vi.fn<typeof import("./agentsapi-session.js").createAgentsApiSession>(),
}));

// The provider turn, instructions, and transfers are separate contracts. Keep the
// registered harness, host generation, binding lifecycle, and SQLite stores real.
vi.mock("./agentsapi-session.js", () => ({ createAgentsApiSession: createSession }));
vi.mock("./agentsapi-prompt.js", () => ({
  buildAgentsApiInstructions: async () => "Fixture instructions",
  buildAgentsApiTurnInput: (_params: unknown, _tools: unknown, prompt: string) => prompt,
}));
vi.mock("./agentsapi-files.js", () => ({
  prepareInputs: async () => ({ files: [], mappingText: "" }),
  prepareSelfHostedInputs: async () => ({ files: [], mappingText: "" }),
  uploadInputs: async () => {},
  collectOutputs: async () => [],
}));
vi.mock("openclaw/plugin-sdk/ssrf-runtime", () => ({
  fetchWithSsrFGuard: () => {
    throw new Error("Unexpected live request in the Agents API persistence fixture");
  },
}));

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(AbortSignal, "timeout").mockImplementation(() => new AbortController().signal);
  createSession.mockImplementation((options) => {
    const turn = completedTurn(options.sessionId);
    return {
      isAvailable: () => false,
      isSettled: () => true,
      wasSubmitted: () => true,
      queueMessage: async () => {},
      readUsageTurns: async () => [],
      run: async (prompt, persistInput, onSubmitted) => {
        await persistInput();
        await options.client.message(options.sessionId, prompt, options.signal);
        onSubmitted();
        options.onSettled?.();
        return { turn, cancelled: false, terminatedByTool: false };
      },
      close: async () => {},
      reconcileAfterClose: async () => turn,
    };
  });
});

afterEach(() => {
  createSession.mockReset();
  resetPluginStateStoreForTests();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

it("reopens an existing hosted binding and requires reset before persisting a fresh self-hosted session", async () => {
  await withOpenClawTestState({ label: "agentsapi-binding-persistence" }, async (state) => {
    const params = await createAttempt(state.stateDir);
    const storeOptions = {
      namespace: "agentsapi-sessions",
      maxEntries: 100_000,
      overflowPolicy: "reject-new" as const,
      env: state.env,
    };
    const openStore = () =>
      createPluginStateKeyedStoreForTests<AgentsApiBinding>("agentsapi", storeOptions);
    // Captured pre-environment-setting identity: SHA-256 of the JSON array
    // ["fixture-model", "fixture-not-a-real-api-key"].
    const hosted = {
      sessionId: "persisted-hosted-session",
      authFingerprint: "3c26b68488ce497a69d2c9fce9ee19c461fa67a3d959b0dc3bafe5718c56119d",
    };
    await openStore().register(params.sessionId, hosted);
    await reopenState();

    const create = vi
      .spyOn(AgentsApiClient.prototype, "create")
      .mockResolvedValue("fresh-self-hosted-session");
    const update = vi
      .spyOn(AgentsApiClient.prototype, "setReasoningEffort")
      .mockResolvedValue(undefined);
    const message = vi.spyOn(AgentsApiClient.prototype, "message").mockResolvedValue(undefined);
    vi.spyOn(AgentsApiClient.prototype, "items").mockResolvedValue([]);
    let config: OpenClawConfig = {};
    const runtime = createBindingRuntime(state.env, () => config);
    const register = () => {
      const registerAgentHarness = vi.fn<OpenClawPluginApi["registerAgentHarness"]>();
      plugin.register(createTestPluginApi({ id: "agentsapi", runtime, registerAgentHarness }));
      const harness = registerAgentHarness.mock.calls[0]?.[0];
      if (!harness?.runAttempt || !harness.reset || !harness.dispose) {
        throw new Error("The registered Agents API harness requires run, reset, and disposal");
      }
      return {
        runAttempt: harness.runAttempt.bind(harness),
        reset: harness.reset.bind(harness),
        dispose: harness.dispose.bind(harness),
      };
    };
    let harness = register();
    try {
      expect(await harness.runAttempt(params)).toEqual(
        expect.objectContaining({ terminal: { kind: "ok" } }),
      );
      expect(await openStore().lookup(params.sessionId)).toEqual(hosted);
      expect(message).toHaveBeenCalledExactlyOnceWith(
        hosted.sessionId,
        params.prompt,
        expect.any(AbortSignal),
      );
      expect(create).toHaveBeenCalledTimes(0);

      config = { plugins: { entries: { agentsapi: { config: { environment: "self_hosted" } } } } };
      const rejected = await harness.runAttempt({ ...params, runId: "switched-run" });
      expect(rejected).toMatchObject({
        terminal: {
          kind: "failed",
          error: expect.objectContaining({
            message:
              "Agents API model, credential, environment, or MCP configuration changed; reset the OpenClaw session before continuing",
          }),
        },
      });
      expect([
        create.mock.calls.length,
        update.mock.calls.length,
        message.mock.calls.length,
      ]).toEqual([0, 1, 1]);
      expect(await openStore().lookup(params.sessionId)).toEqual(hosted);

      await harness.reset({ sessionId: params.sessionId, reason: "reset" });
      await harness.dispose();
      await reopenState();
      harness = register();
      expect(await harness.runAttempt({ ...params, runId: "reset-run" })).toEqual(
        expect.objectContaining({ terminal: { kind: "ok" } }),
      );
      expect(create).toHaveBeenCalledExactlyOnceWith(
        expect.any(AbortSignal),
        "Fixture instructions",
        "fixture-model",
        expect.objectContaining({
          environment: { type: "self_hosted", workspace_directory: params.workspaceDir },
        }),
      );
      const fresh = await openStore().lookup(params.sessionId);
      expect(fresh).toMatchObject({
        sessionId: "fresh-self-hosted-session",
        authFingerprint: expect.any(String),
      });
      await harness.dispose();
      await reopenState();
      expect(await openStore().lookup(params.sessionId)).toEqual(fresh);
      harness = register();
      expect(await harness.runAttempt({ ...params, runId: "reopened-self-hosted-run" })).toEqual(
        expect.objectContaining({ terminal: { kind: "ok" } }),
      );
      expect(create).toHaveBeenCalledTimes(1);
      expect(message.mock.calls.map(([sessionId]) => sessionId)).toEqual([
        hosted.sessionId,
        "fresh-self-hosted-session",
        "fresh-self-hosted-session",
      ]);
    } finally {
      await harness.dispose();
    }
  });
});

it("retains the executor binding after uncertain startup and waits for readiness before resuming it", async () => {
  await withOpenClawTestState({ label: "agentsapi-executor-recovery" }, async (state) => {
    const fixture = await executorFixture(state);
    let harness = fixture.createHarness();
    let savedBeforeStartup: AgentsApiBinding | undefined;
    fixture.controller.ensure.mockImplementationOnce(async () => {
      savedBeforeStartup = await fixture.openStore().lookup(fixture.params.sessionId);
      throw new Error("Executor startup was not acknowledged");
    });
    try {
      expect(await harness.runAttempt(fixture.params)).toMatchObject({
        terminal: {
          kind: "failed",
          error: expect.objectContaining({ message: "Executor startup was not acknowledged" }),
        },
      });
      expect(savedBeforeStartup).toMatchObject({
        sessionId: "native-executor-session",
        executor: {
          sessionKey: fixture.params.sessionKey,
          agentId: "main",
          nativeSessionId: "native-executor-session",
          environmentId: "executor-environment",
          remoteUrl: "wss://executor.example.test/session",
          workspaceDirectory: "/executor/project",
        },
      });
      expect(fixture.create.mock.calls[0]?.[3]?.environment).toEqual({
        type: "self_hosted",
        workspace_directory: "/executor/project",
      });
      expect(fixture.message).not.toHaveBeenCalled();
      await harness.dispose();
      await reopenState();
      expect(await fixture.openStore().lookup(fixture.params.sessionId)).toEqual(savedBeforeStartup);

      harness = fixture.createHarness();
      const readinessRequested = Promise.withResolvers<void>();
      const readiness = Promise.withResolvers<Awaited<ReturnType<AgentsApiClient["environment"]>>>();
      fixture.environment.mockImplementationOnce(async () => {
        readinessRequested.resolve();
        return await readiness.promise;
      });
      const resumed = harness.runAttempt({ ...fixture.params, runId: "recovered-executor-run" });
      try {
        await Promise.race([
          readinessRequested.promise,
          resumed.then(() => {
            throw new Error("The attempt finished without waiting for executor readiness");
          }),
        ]);
        expect(fixture.message).not.toHaveBeenCalled();
      } finally {
        readiness.resolve(connectedEnvironment());
      }
      expect(await resumed).toMatchObject({ terminal: { kind: "ok" } });
      expect(fixture.create).toHaveBeenCalledTimes(1);
      expect(fixture.controller.ensure.mock.calls.map(([binding]) => binding)).toEqual([
        savedBeforeStartup?.executor,
        savedBeforeStartup?.executor,
      ]);
      expect(fixture.message).toHaveBeenCalledExactlyOnceWith(
        "native-executor-session",
        fixture.params.prompt,
        expect.any(AbortSignal),
      );
    } finally {
      await harness.dispose();
    }
  });
});

it("settles native work before reset and retains the binding when executor retirement fails", async () => {
  await withOpenClawTestState({ label: "agentsapi-executor-reset" }, async (state) => {
    const fixture = await executorFixture(state);
    const harness = fixture.createHarness();
    try {
      expect(await harness.runAttempt(fixture.params)).toMatchObject({ terminal: { kind: "ok" } });
      const saved = await fixture.openStore().lookup(fixture.params.sessionId);
      fixture.events.length = 0;
      fixture.session.mockResolvedValue({ ...fixture.nativeSession, status: "in_progress" });
      fixture.controller.retire.mockImplementationOnce(async () => {
        fixture.events.push("retire");
        expect(await fixture.openStore().lookup(fixture.params.sessionId)).toMatchObject(saved!);
        throw new Error("Executor retirement was not acknowledged");
      });

      await expect(
        harness.reset({ sessionId: fixture.params.sessionId, reason: "reset" }),
      ).rejects.toThrow("Executor retirement was not acknowledged");
      expect(fixture.events).toEqual(["cancel", "retire"]);
      expect(await fixture.openStore().lookup(fixture.params.sessionId)).toEqual(saved);

      await harness.reset({ sessionId: fixture.params.sessionId, reason: "reset" });
      expect(fixture.events).toEqual(["cancel", "retire", "cancel", "retire"]);
      expect(fixture.controller.retire.mock.calls.map(([binding]) => binding)).toEqual([
        saved?.executor,
        saved?.executor,
      ]);
      expect(await fixture.openStore().lookup(fixture.params.sessionId)).toEqual({});
    } finally {
      await harness.dispose();
    }
  });
});

it("can reset a retained executor after a restarted harness rejects a configuration change", async () => {
  await withOpenClawTestState({ label: "agentsapi-executor-config-reset" }, async (state) => {
    const fixture = await executorFixture(state);
    let harness = fixture.createHarness();
    try {
      expect(await harness.runAttempt(fixture.params)).toMatchObject({ terminal: { kind: "ok" } });
      const saved = await fixture.openStore().lookup(fixture.params.sessionId);
      await harness.dispose();
      await reopenState();
      vi.spyOn(fixture.runtime.config, "current").mockReturnValue({
        plugins: { entries: { agentsapi: { config: { environment: "openai_hosted" } } } },
      });
      harness = fixture.createHarness();

      const rejected = await harness.runAttempt({ ...fixture.params, runId: "changed-config-run" });
      expect(rejected).toMatchObject({
        terminal: {
          kind: "failed",
          error: expect.objectContaining({
            message:
              "Agents API model, credential, environment, or MCP configuration changed; reset the OpenClaw session before continuing",
          }),
        },
      });
      expect(await fixture.openStore().lookup(fixture.params.sessionId)).toEqual(saved);

      await harness.reset({ sessionId: fixture.params.sessionId, reason: "reset" });
      expect(fixture.controller.retire).toHaveBeenCalledExactlyOnceWith(
        saved?.executor,
        expect.objectContaining({ signal: expect.any(AbortSignal), assertCurrent: expect.any(Function) }),
      );
      expect(await fixture.openStore().lookup(fixture.params.sessionId)).toEqual({});
      expect(fixture.create).toHaveBeenCalledTimes(1);
    } finally {
      await harness.dispose();
    }
  });
});

it("preserves an owned executor binding when its deployment controller is unavailable", async () => {
  await withOpenClawTestState({ label: "agentsapi-executor-missing-controller" }, async (state) => {
    const fixture = await executorFixture(state);
    let harness = fixture.createHarness();
    try {
      expect(await harness.runAttempt(fixture.params)).toMatchObject({ terminal: { kind: "ok" } });
      const saved = await fixture.openStore().lookup(fixture.params.sessionId);
      await harness.dispose();
      await reopenState();
      harness = requireExecutorHarness(fixture.runtime);
      const rejected = await harness.runAttempt({ ...fixture.params, runId: "missing-controller-run" });
      expect(rejected).toMatchObject({
        terminal: {
          kind: "failed",
          error: expect.objectContaining({
            message:
              "Agents API self-hosted executor controller is unavailable; restore it before continuing",
          }),
        },
      });
      await expect(
        harness.reset({ sessionId: fixture.params.sessionId, reason: "reset" }),
      ).rejects.toThrow("Agents API self-hosted executor cleanup is unavailable");
      const deleteSession = vi.fn(async () => {});
      await expect(
        harness.withSessionDeletion(
          { ...fixture.params.sessionTarget!, assertCurrent: () => {} },
          deleteSession,
        ),
      ).rejects.toThrow("Agents API self-hosted executor cleanup is unavailable");
      expect(deleteSession).not.toHaveBeenCalled();
      expect(fixture.message).toHaveBeenCalledTimes(1);
      expect(await fixture.openStore().lookup(fixture.params.sessionId)).toEqual(saved);
    } finally {
      await harness.dispose();
    }
  });
});

it.each([false, true])(
  "retires an executor before session deletion and preserves rollback recovery (rollback: %s)",
  async (rollback) => {
    await withOpenClawTestState({ label: "agentsapi-executor-delete" }, async (state) => {
      const fixture = await executorFixture(state);
      const harness = fixture.createHarness();
      try {
        expect(await harness.runAttempt(fixture.params)).toMatchObject({ terminal: { kind: "ok" } });
        const saved = await fixture.openStore().lookup(fixture.params.sessionId);
        fixture.events.length = 0;
        fixture.session.mockResolvedValue({ ...fixture.nativeSession, status: "in_progress" });

        await harness.withSessionDeletion(
          { ...fixture.params.sessionTarget!, assertCurrent: () => {} },
          async (mutation) => {
            expect(fixture.events).toEqual(["cancel", "retire"]);
            mutation.commit();
            fixture.events.push("commit");
            if (rollback) {
              mutation.rollback();
              fixture.events.push("rollback");
            }
          },
        );

        expect(fixture.events).toEqual(
          rollback ? ["cancel", "retire", "commit", "rollback"] : ["cancel", "retire", "commit"],
        );
        expect(await fixture.openStore().lookup(fixture.params.sessionId)).toEqual(
          rollback ? saved : undefined,
        );
        if (rollback) {
          await harness.withSessionDeletion(
            { ...fixture.params.sessionTarget!, assertCurrent: () => {} },
            async (mutation) => mutation.commit(),
          );
          expect(fixture.controller.retire.mock.calls.map(([binding]) => binding)).toEqual([
            saved?.executor,
            saved?.executor,
          ]);
          expect(await fixture.openStore().lookup(fixture.params.sessionId)).toBeUndefined();
        }
      } finally {
        await harness.dispose();
      }
    });
  },
);

it("preserves the executor binding and skips session deletion when retirement fails", async () => {
  await withOpenClawTestState({ label: "agentsapi-executor-delete-failure" }, async (state) => {
    const fixture = await executorFixture(state);
    const harness = fixture.createHarness();
    try {
      expect(await harness.runAttempt(fixture.params)).toMatchObject({ terminal: { kind: "ok" } });
      const saved = await fixture.openStore().lookup(fixture.params.sessionId);
      fixture.controller.retire.mockRejectedValueOnce(
        new Error("Executor retirement was not acknowledged"),
      );
      const deleteSession = vi.fn(async () => {});
      const target = { ...fixture.params.sessionTarget!, assertCurrent: () => {} };

      await expect(harness.withSessionDeletion(target, deleteSession)).rejects.toThrow(
        "Executor retirement was not acknowledged",
      );
      expect(deleteSession).not.toHaveBeenCalled();
      expect(await fixture.openStore().lookup(fixture.params.sessionId)).toEqual(saved);

      await harness.withSessionDeletion(target, async (mutation) => mutation.commit());
      expect(fixture.controller.retire.mock.calls.map(([binding]) => binding)).toEqual([
        saved?.executor,
        saved?.executor,
      ]);
      expect(await fixture.openStore().lookup(fixture.params.sessionId)).toBeUndefined();
    } finally {
      await harness.dispose();
    }
  });
});

async function executorFixture(state: { stateDir: string; env: NodeJS.ProcessEnv }) {
  const params = await createAttempt(state.stateDir);
  const runtime = createBindingRuntime(state.env, () => ({
    plugins: { entries: { agentsapi: { config: { environment: "self_hosted" } } } },
  }));
  const openStore = () =>
    createPluginStateKeyedStoreForTests<AgentsApiBinding>("agentsapi", {
      namespace: "agentsapi-sessions",
      maxEntries: 100_000,
      overflowPolicy: "reject-new",
      env: state.env,
    });
  const events: string[] = [];
  const controller = {
    workspace: vi.fn<AgentsApiExecutorController["workspace"]>(async () => "/executor/project"),
    ensure: vi.fn<AgentsApiExecutorController["ensure"]>(async () => {}),
    retire: vi.fn<AgentsApiExecutorController["retire"]>(async () => {
      events.push("retire");
    }),
  };
  const nativeSession: Awaited<ReturnType<AgentsApiClient["session"]>> = {
    id: "native-executor-session",
    agent: {
      id: "fixture-agent",
      instructions: "Fixture instructions",
      model: "fixture-model",
      multi_agent: { enabled: false, max_concurrent_subagents: null },
      name: null,
      reasoning: { effort: null, summary: null },
      service_tier: "auto",
      text: { format: { type: "text" }, verbosity: "medium" },
      tools: [],
    },
    created_at: 1,
    last_active_at: 2,
    metadata: {},
    object: "agent.session",
    status: "idle",
    error: null,
    usage: null,
    vault_ids: [],
    environment: {
      id: "executor-environment",
      type: "self_hosted",
      capability_directories: [],
      workspace_directory: "/executor/project",
      remote_url: "wss://executor.example.test/session",
    },
    required_actions: [],
  };
  const create = vi.spyOn(AgentsApiClient.prototype, "create").mockResolvedValue(nativeSession.id);
  const session = vi.spyOn(AgentsApiClient.prototype, "session").mockResolvedValue(nativeSession);
  const environment = vi
    .spyOn(AgentsApiClient.prototype, "environment")
    .mockResolvedValue(connectedEnvironment());
  const message = vi.spyOn(AgentsApiClient.prototype, "message").mockResolvedValue(undefined);
  vi.spyOn(AgentsApiClient.prototype, "cancel").mockImplementation(async () => {
    events.push("cancel");
  });
  vi.spyOn(AgentsApiClient.prototype, "setReasoningEffort").mockResolvedValue(undefined);
  vi.spyOn(AgentsApiClient.prototype, "items").mockResolvedValue([]);
  return {
    params,
    runtime,
    openStore,
    controller,
    nativeSession,
    create,
    session,
    environment,
    message,
    events,
    createHarness: () => requireExecutorHarness(runtime, controller),
  };
}

function requireExecutorHarness(
  runtime: PluginRuntime,
  executorController?: AgentsApiExecutorController,
) {
  const harness = createAgentsApiHarness(runtime, { executorController });
  if (!harness.runAttempt || !harness.reset || !harness.withSessionDeletion || !harness.dispose) {
    throw new Error("The Agents API harness requires run, reset, deletion, and disposal");
  }
  return {
    runAttempt: harness.runAttempt.bind(harness),
    reset: harness.reset.bind(harness),
    withSessionDeletion: harness.withSessionDeletion.bind(harness),
    dispose: harness.dispose.bind(harness),
  };
}

function createBindingRuntime(env: NodeJS.ProcessEnv, current: () => OpenClawConfig) {
  const runtime = createPluginRuntimeMock({ config: { current } });
  runtime.state.openKeyedStore = <T>(
    options: Parameters<typeof runtime.state.openKeyedStore>[0],
  ) => createPluginStateKeyedStoreForTests<T>("agentsapi", { ...options, env });
  runtime.state.openSyncKeyedStore = <T>(
    options: Parameters<typeof runtime.state.openSyncKeyedStore>[0],
  ) => createPluginStateSyncKeyedStoreForTests<T>("agentsapi", { ...options, env });
  return runtime;
}

function connectedEnvironment(): Awaited<ReturnType<AgentsApiClient["environment"]>> {
  return {
    id: "executor-environment",
    type: "self_hosted",
    status: "connected",
    object: "agent.environment",
    files: [],
    plugins: [],
    skills: [],
  };
}

async function reopenState() {
  await closeOpenClawStateDatabaseAsync();
  resetPluginStateStoreForTests();
}

async function createAttempt(stateDir: string): Promise<AgentHarnessAttemptParamsV2> {
  const target = {
    agentId: "main",
    sessionId: "local-persisted-session",
    sessionKey: "agent:main:persisted-session",
    storePath: path.join(stateDir, "openclaw-agent.sqlite"),
  };
  await upsertSessionEntry({
    ...target,
    entry: { sessionId: target.sessionId, updatedAt: Date.now() },
  });
  const authStorage = AuthStorage.inMemory();
  return {
    ...target,
    sessionTarget: target,
    sessionFile: path.join(stateDir, "session.jsonl"),
    workspaceDir: stateDir,
    agentDir: stateDir,
    config: {},
    runId: "persisted-run",
    prompt: "Continue the retained conversation.",
    timeoutMs: 5_000,
    provider: "openai",
    modelId: "fixture-model",
    model: {
      id: "fixture-model",
      name: "Fixture Model",
      api: "openai-responses",
      provider: "openai",
      baseUrl: "https://api.openai.com/v1",
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 1024,
      maxTokens: 512,
    },
    resolvedApiKey: "fixture-not-a-real-api-key",
    authStorage,
    modelRegistry: ModelRegistry.inMemory(authStorage),
    authProfileStore: { version: 1, profiles: {} },
    thinkLevel: "off",
    hostCapabilities: {
      kind: "agent-harness-host-capability",
      version: 1,
      assertActive: () => {},
      createToolSurface: () => [],
      bindToolSurface: (tools) => tools,
      runBeforeToolCall: async (request) => ({ blocked: false, params: request.params }),
      requestApproval: async () => undefined,
      waitForApproval: async () => undefined,
    },
  };
}

function completedTurn(sessionId: string): Turn {
  return {
    id: `turn-${sessionId}`,
    agent_id: "fixture-agent",
    session_id: sessionId,
    object: "agent.session.turn",
    created_at: 1,
    started_at: 1,
    completed_at: 2,
    status: "completed",
    subagent_id: null,
    error: null,
    usage: null,
  };
}
