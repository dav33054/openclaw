/**
 * Real-trigger proof for the `sessions.abort` state-contention fix (PR #159282).
 *
 * The contention is not injected: a child process holds `BEGIN EXCLUSIVE` on the
 * real `state-lifecycle` coordinator database while a Control UI client calls
 * `sessions.abort` for a session with a live run. The recipe (acquire the
 * coordinator path, release it, let a spawned child own the lock) is the one
 * already used by `src/config/sessions/session-history-eviction.lifecycle-contention.test.ts`.
 *
 * Expected on the fixed head: the RPC rejects with the typed
 * `UNAVAILABLE` / `details.errorKind === "state_contention"` shape.
 * Expected on unmodified base production: the raw
 * `StateDatabaseCoordinatorContentionError` escapes the handler instead.
 *
 * Throw site: `sessions.abort` reads its session before delegating, so for a
 * configured agent the contention surfaces from that own read
 * (`sessions-abort.ts` `loadSessionEntry`), not from the delegated lifecycle call.
 * The read only reaches storage admission while the agent database is closed,
 * which is why the test closes it before taking the lock; with a warm agent
 * database the same Stop completes and acquires nothing.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import { createServer, type Server, type ServerResponse } from "node:http";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { stopChildProcess } from "../../../test/helpers/stop-child-process.js";
import { clearConfigCache, clearRuntimeConfigSnapshot } from "../../config/config.js";
import { clearSessionStoreCacheForTest } from "../../config/sessions/store-writer-state.js";
import { acquireStateDatabaseCoordinator } from "../../infra/state-database-coordinator.js";
import {
  closeOpenClawAgentDatabasesForTest,
  closeOpenClawAgentDatabasesAsync,
} from "../../state/openclaw-agent-db.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../../state/openclaw-state-db.paths.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import { acquireTestPortBlock } from "../../test-utils/port-claims.js";
import { GATEWAY_CLIENT_MODES, GATEWAY_CLIENT_NAMES } from "../../utils/message-channel.js";
import { disconnectGatewayClient, startGatewayWithClient } from "../test-helpers.e2e.js";
import { buildMockOpenAiResponsesProvider } from "../test-openai-responses-model.js";

const GATEWAY_TOKEN = "sessions-abort-live-proof-token";
const SESSION_KEY = "agent:main:sessions-abort-live-proof";

let state: OpenClawTestState | undefined;
let providerServer: Server | undefined;
let gateway: Awaited<ReturnType<typeof startGatewayWithClient>> | undefined;
let lockChild: ChildProcess | undefined;
let lockReleased = false;

async function releaseLockChild(): Promise<void> {
  const child = lockChild;
  lockChild = undefined;
  if (!child) {
    return;
  }
  if (!lockReleased && child.connected) {
    child.send({ release: true });
  }
  try {
    if (child.exitCode === null) {
      await once(child, "close", { signal: AbortSignal.timeout(5_000) }).catch(() => undefined);
    }
  } finally {
    await stopChildProcess(child, 5_000).catch(() => undefined);
  }
}

/** Hold the real state-lifecycle coordinator from a separate OS process. */
async function holdStateLifecycleLock(coordinatorPath: string): Promise<void> {
  lockReleased = false;
  const child = spawn(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      `
        import { DatabaseSync } from 'node:sqlite';
        const db = new DatabaseSync(process.argv[1]);
        db.exec('PRAGMA journal_mode=MEMORY; BEGIN EXCLUSIVE');
        process.send({ ready: true });
        process.once('message', () => {
          db.exec('ROLLBACK');
          db.close();
          process.disconnect();
        });
      `,
      coordinatorPath,
    ],
    { stdio: ["ignore", "ignore", "pipe", "ipc"] },
  );
  lockChild = child;
  const [ready] = await once(child, "message", { signal: AbortSignal.timeout(10_000) });
  expect(ready).toEqual({ ready: true });
}

afterEach(async () => {
  await releaseLockChild();
  if (gateway) {
    await disconnectGatewayClient(gateway.client).catch(() => undefined);
    await gateway.server.close().catch(() => undefined);
    gateway = undefined;
  }
  if (providerServer?.listening) {
    const server = providerServer;
    providerServer = undefined;
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    });
  }
  await closeOpenClawAgentDatabasesAsync().catch(() => undefined);
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
  clearSessionStoreCacheForTest();
  clearRuntimeConfigSnapshot();
  clearConfigCache();
  await state?.cleanup();
  state = undefined;
});

it(
  "sessions.abort keeps the typed state-contention outcome under a foreign lock",
  { timeout: 150_000 },
  async () => {
    const testState = await createOpenClawTestState({
      layout: "home",
      prefix: "openclaw-sessions-abort-live-",
      env: {
        OPENCLAW_SKIP_CHANNELS: "1",
        OPENCLAW_SKIP_GMAIL_WATCHER: "1",
        OPENCLAW_SKIP_CRON: "1",
        OPENCLAW_SKIP_CANVAS_HOST: "1",
        OPENCLAW_SKIP_BROWSER_CONTROL_SERVER: "1",
        OPENCLAW_SKIP_PROVIDERS: "1",
        OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
      },
    });
    state = testState;

    // A provider that accepts the turn and then never completes it: the run stays
    // active for the whole proof window, so Stop has a real live run to cancel.
    const stalledResponses: ServerResponse[] = [];
    providerServer = createServer((request, response) => {
      request.resume();
      response.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      response.write(
        `data: ${JSON.stringify({
          type: "response.output_item.added",
          output_index: 0,
          item: {
            type: "message",
            id: "stalled-proof-item",
            role: "assistant",
            status: "in_progress",
            content: [],
          },
        })}\n\n`,
      );
      stalledResponses.push(response);
    });
    await new Promise<void>((resolve, reject) => {
      providerServer?.once("error", reject);
      providerServer?.listen(0, "127.0.0.1", resolve);
    });
    const providerAddress = providerServer.address();
    if (!providerAddress || typeof providerAddress === "string") {
      throw new Error("proof provider did not bind a loopback port");
    }
    const provider = buildMockOpenAiResponsesProvider(
      `http://127.0.0.1:${providerAddress.port}/v1`,
    );

    const portClaim = await acquireTestPortBlock({ offsets: [0, 1, 2, 3, 4] });
    gateway = await startGatewayWithClient({
      portClaim,
      origin: `http://127.0.0.1:${portClaim.port}`,
      cfg: {
        agents: {
          defaults: {
            workspace: testState.workspaceDir,
            skipBootstrap: true,
            model: { primary: provider.modelRef },
          },
          entries: { main: { default: true } },
        },
        models: { mode: "replace", providers: { [provider.providerId]: provider.config } },
        gateway: { auth: { mode: "token", token: GATEWAY_TOKEN } },
      },
      configPath: testState.configPath,
      token: GATEWAY_TOKEN,
      clientName: GATEWAY_CLIENT_NAMES.CONTROL_UI,
      mode: GATEWAY_CLIENT_MODES.WEBCHAT,
      clientDisplayName: "sessions-abort-live-proof",
      // The Control UI operator carries admin; the session-write scope is present
      // because it is the documented narrow alternative for sessions.abort.
      scopes: ["operator.admin", "operator.sessions.write"],
    });

    const started = await gateway.client.request<{ runId?: string; status?: string }>("chat.send", {
      sessionKey: SESSION_KEY,
      message: "Hold this turn open until the proof stops it.",
      deliver: false,
      idempotencyKey: "sessions-abort-live-proof-run",
    });
    expect(started.status).toBe("started");
    const runId = started.runId;
    expect(runId).toBeTruthy();
    const waiting = await gateway.client.request<{ status?: string }>(
      "agent.wait",
      { runId, timeoutMs: 250 },
      { timeoutMs: 10_000 },
    );
    // "timeout" proves the run is still live at the moment Stop is sent.
    expect(waiting.status).toBe("timeout");

    // The handler's session read only reaches storage admission while the agent
    // database is closed, so drop it and make Stop re-open under the foreign lock.
    await closeOpenClawAgentDatabasesAsync();

    // Resolve the exact coordinator the Gateway uses, then hand the lock to a
    // child process so no in-process ownership can absorb the contention.
    const databasePath = resolveOpenClawStateSqlitePath(testState.env);
    const lease = acquireStateDatabaseCoordinator({ databasePath, busyTimeoutMs: 0 });
    const coordinatorPath = lease.path;
    lease.release();
    expect(path.basename(coordinatorPath)).toMatch(/^state-lifecycle\.[0-9a-f]+\.lock\.sqlite$/);
    fs.mkdirSync(path.dirname(coordinatorPath), { recursive: true, mode: 0o700 });
    await holdStateLifecycleLock(coordinatorPath);

    // The child owns the live coordinator path: a real state-lifecycle acquisition
    // is refused while it holds the lock.
    const stateDb = openOpenClawStateDatabase({ env: testState.env });
    expect(stateDb.walMaintenance.checkpoint()).toBe(false);
    expect(String(stateDb.walMaintenance.health?.error ?? "")).toContain("state-lifecycle");

    const outcome = await gateway.client
      .request("sessions.abort", { key: SESSION_KEY, runId }, { timeoutMs: 30_000 })
      .then(
        (payload) => ({ rpc: "resolved" as const, payload }),
        (error: unknown) => ({
          rpc: "rejected" as const,
          name: (error as Error)?.name,
          code: (error as { code?: string })?.code,
          details: (error as { details?: unknown })?.details,
          message: (error as Error)?.message,
        }),
      );
    console.info(`SESSIONS_ABORT_CONTENTION_LIVE ${JSON.stringify(outcome)}`);

    lockReleased = true;
    await releaseLockChild();
    for (const response of stalledResponses) {
      response.destroy();
    }

    expect(outcome).toMatchObject({
      rpc: "rejected",
      code: "UNAVAILABLE",
      details: { errorKind: "state_contention" },
      message: expect.stringContaining("state-lifecycle acquisition remained busy"),
    });
  },
);
