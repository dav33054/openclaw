import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { OpenClawStateWorkerContext } from "../../../state/openclaw-state-worker-context.types.js";
import { createSubagentRunRecord } from "../../subagent-test-fixtures.test-helpers.js";
import { subagentRuns } from "./subagent-registry-memory.js";
import { SubagentRegistryWriteError } from "./subagent-registry-persistence.js";
import { createQueuedRegistrationFixture } from "./subagent-registry-queued-registration.test-support.js";
import type { SubagentLaunchManager } from "./subagent-registry-run-launch.js";

const mocks = vi.hoisted(() => ({
  register: vi.fn<SubagentLaunchManager["registerSubagentRun"]>(),
  persisted: new Set<() => void>(),
  lifecycle: "original",
  context: undefined as OpenClawStateWorkerContext | undefined,
}));
vi.mock("../../../gateway/server-plugin-in-process-dispatch.js", () => ({
  captureOperatorToolGatewayContinuationContext: () => undefined,
}));
vi.mock("../../../infra/agent-events.js", () => ({
  registerAgentEventLifecycleRotationHandler: vi.fn(),
  onAgentEvent: () => () => {},
  getAgentEventLifecycleGeneration: () => mocks.lifecycle,
  isAgentEventLifecycleGenerationCurrent: (value: string) => value === mocks.lifecycle,
}));
vi.mock("../../../state/openclaw-state-worker-context.js", () => ({
  captureOpenClawStateWorkerContext: () => mocks.context,
}));
vi.mock("./subagent-session-reconciliation.js", () => ({
  loadSubagentSessionEntry: () => undefined,
}));

function fixture() {
  const f = createQueuedRegistrationFixture(mocks, subagentRuns);
  Object.assign(f.registration, {
    runId: "running-original",
    queued: false,
    collect: false,
    queuedLaunch: undefined,
  });
  vi.spyOn(f.manager, "waitForSubagentCompletion").mockResolvedValue(undefined);
  return f;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.persisted.clear();
  subagentRuns.clear();
  mocks.lifecycle = "original";
  mocks.context = {
    admission: {
      databasePath: "/synthetic/state.sqlite",
      coordinationKey: "original",
      identity: { key: "original", canonicalPath: "/synthetic/state.sqlite" },
      assertCurrent() {},
    },
    environment: { OPENCLAW_STATE_DIR: "/synthetic" },
  };
});
afterEach(() => {
  subagentRuns.clear();
  vi.restoreAllMocks();
});

it("publishes the registration and predecessor change only after acknowledgement", async () => {
  const f = fixture();
  const previous = createSubagentRunRecord({
    runId: "previous",
    childSessionKey: f.registration.childSessionKey,
    generation: 1,
    createdAt: 1,
    execution: { status: "terminal", endedAt: 2 },
    killReconciliation: { killedAt: 2 },
  });
  f.runs.set(previous.runId, previous);
  const pending = f.register();
  const write = f.writes[0] ?? (await f.nextWrite);
  expect(f.runs.has(f.registration.runId)).toBe(false);
  expect(previous.killReconciliation).toEqual({ killedAt: 2 });
  expect(write.snapshot.get(f.registration.runId)).toMatchObject({
    execution: { status: "running" },
  });
  expect(write.snapshot.get(previous.runId)?.killReconciliation?.supersededAt).toBeTypeOf("number");
  expect(f.options.ensureListener).not.toHaveBeenCalled();
  expect(f.scope.canLaunch()).toBe(false);
  write.assertCurrent();
  write.gate.resolve();
  await pending;
  expect(f.runs.get(f.registration.runId)).toMatchObject({
    runId: f.registration.runId,
    execution: { status: "running" },
  });
  expect(previous.killReconciliation?.supersededAt).toBeTypeOf("number");
  expect(f.scope.canLaunch()).toBe(true);
  expect(f.scope.canCleanupSession()).toBe(false);
  expect(f.options.ensureListener).toHaveBeenCalledOnce();
  expect(f.options.startSweeper).toHaveBeenCalledOnce();
  expect(f.manager.waitForSubagentCompletion).toHaveBeenCalledOnce();
  expect(f.options.persistOrThrow).not.toHaveBeenCalled();
  expect(f.writes).toHaveLength(1);
});

it.each(["not-committed", "unknown"] as const)(
  "preserves the %s write outcome without publication or replay",
  async (outcome) => {
    const f = fixture();
    const pending = Promise.resolve(f.register()).catch((error: unknown) => error);
    const write = f.writes[0] ?? (await f.nextWrite);
    const failure = new SubagentRegistryWriteError(outcome, new Error("write failed"));
    write.gate.reject(failure);
    expect(await pending).toBe(failure);
    expect(f.runs.has(f.registration.runId)).toBe(false);
    expect(f.scope.canCleanupSession()).toBe(outcome === "not-committed");
    expect(f.scope.canAcceptLaunch()).toBe(false);
    expect(f.scope.canAbortAcceptedRun()).toBe(true);
    expect(f.options.ensureListener).not.toHaveBeenCalled();
    expect(f.options.persistOrThrow).not.toHaveBeenCalled();
    expect(f.writes).toHaveLength(1);
  },
);

it("retains an acknowledged registration for observation after publication settlement fails", async () => {
  const f = fixture();
  const pending = Promise.resolve(f.register()).catch((error: unknown) => error);
  const write = f.writes[0] ?? (await f.nextWrite);
  const failure = new SubagentRegistryWriteError("committed", new Error("publication tail failed"));
  write.afterPublicationFailure = { error: failure };
  write.gate.resolve();
  expect(await pending).toBe(failure);
  expect(f.runs.get(f.registration.runId)).toMatchObject({ runId: f.registration.runId });
  expect(f.scope.canCleanupSession()).toBe(false);
  expect(f.options.ensureListener).toHaveBeenCalledOnce();
  expect(f.options.startSweeper).toHaveBeenCalledOnce();
  expect(f.options.persistOrThrow).not.toHaveBeenCalled();
  expect(f.writes).toHaveLength(1);
});

it.each(["caller", "database", "lifecycle"] as const)(
  "refuses commit after the captured %s authority retires",
  async (owner) => {
    const f = fixture();
    let callerCurrent = true;
    const pending = Promise.resolve(
      f.register(() => {
        if (!callerCurrent) {
          throw new Error("caller retired");
        }
      }),
    ).catch((error: unknown) => error);
    const write = f.writes[0] ?? (await f.nextWrite);
    if (owner === "caller") {
      callerCurrent = false;
    } else if (owner === "lifecycle") {
      mocks.lifecycle = "successor";
    } else {
      const original = mocks.context!;
      mocks.context = {
        ...original,
        admission: {
          ...original.admission,
          identity: { ...original.admission.identity, key: "successor" },
        },
      };
    }
    expect(write.assertCurrent).toThrow();
    const failure = new SubagentRegistryWriteError("not-committed", new Error("admission refused"));
    write.gate.reject(failure);
    expect(await pending).toBe(failure);
    expect(f.runs.has(f.registration.runId)).toBe(false);
    expect(f.options.ensureListener).not.toHaveBeenCalled();
    expect(f.scope.canLaunch()).toBe(false);
    expect(f.writes).toHaveLength(1);
  },
);

it("keeps an acknowledged old run tracked when a different run owns the child before publication", async () => {
  const f = fixture();
  const pending = Promise.resolve(f.register()).catch((error: unknown) => error);
  const write = f.writes[0] ?? (await f.nextWrite);
  const captured = write.snapshot.get(f.registration.runId)!;
  write.assertCurrent();
  const successor = createSubagentRunRecord({ ...captured, runId: "successor", generation: 2 });
  f.runs.set(successor.runId, successor);
  subagentRuns.commitOwnership(successor);
  write.gate.resolve();
  expect(await pending).toBeInstanceOf(Error);
  expect(f.runs.get(f.registration.runId)).toEqual(captured);
  expect(f.runs.get(successor.runId)).toBe(successor);
  expect(f.options.ensureListener).toHaveBeenCalledOnce();
  expect(f.scope.canCleanupSession()).toBe(false);
  expect(f.scope.canAbortAcceptedRun()).toBe(false);
  expect(f.writes).toHaveLength(1);
});

it.each(["same run", "different run"] as const)(
  "preserves a %s successor that commits and retires before the earlier acknowledgement",
  async (replacement) => {
    const f = fixture();
    const pending = Promise.resolve(f.register()).catch((error: unknown) => error);
    const write = f.writes[0] ?? (await f.nextWrite);
    const captured = write.snapshot.get(f.registration.runId)!;
    write.assertCurrent();
    const successor = createSubagentRunRecord({
      ...captured,
      runId: replacement === "same run" ? f.registration.runId : "successor",
      generation: 2,
    });
    f.runs.set(successor.runId, successor);
    subagentRuns.commitOwnership(successor);
    f.runs.delete(successor.runId);
    write.gate.resolve();
    expect(await pending).toBeInstanceOf(Error);
    expect(f.runs.has(f.registration.runId)).toBe(replacement === "different run");
    expect(f.scope.canCleanupSession()).toBe(false);
    expect(f.scope.canAbortAcceptedRun()).toBe(false);
    expect(f.options.ensureListener).toHaveBeenCalledTimes(replacement === "different run" ? 1 : 0);
    expect(f.writes).toHaveLength(1);
  },
);
