/**
 * Execution owner selection for isolated completions. Dispatch and status
 * displays share this decision, so a surface that reports "Claude CLI" or
 * "API" for a utility model cannot drift from the route the completion takes.
 * Kept apart from isolated-completion.ts so readers do not load run machinery.
 */
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveAgentDir, resolveAgentWorkspaceDir, resolveDefaultAgentId } from "./agent-scope.js";
import { resolveCliRuntimeCanonicalProvider } from "./cli-backends.js";
import { resolveEmbeddedCliBackendDispatchEligibility } from "./embedded-agent-runner/cli-backend-dispatch-eligibility.js";
import {
  resolveAgentHarnessSelectionDecision,
  type AgentHarnessSelectionDecision,
} from "./harness/selection-decision.js";
import {
  isCliRuntimeAliasForProvider,
  resolveCliRuntimeExecutionProvider,
} from "./model-runtime-aliases.js";

export type IsolatedCompletionRouteParams = {
  config?: OpenClawConfig;
  provider: string;
  model: string;
  authProfileId?: string;
  agentId?: string;
  agentDir?: string;
  workspaceDir?: string;
  agentHarnessRuntimeOverride?: string;
};

/** A CLI runtime ref canonicalizes to its model provider but keeps the CLI as its explicit owner. */
export function resolveIsolatedCompletionProvider(params: {
  provider: string;
  config: OpenClawConfig;
  agentHarnessRuntimeOverride?: string;
}): { provider: string; runtimeOverride?: string } {
  const canonicalProvider = resolveCliRuntimeCanonicalProvider({
    runtime: params.provider,
    config: params.config,
    includeSetupRegistry: true,
  });
  const runtimeOverride =
    params.agentHarnessRuntimeOverride ?? (canonicalProvider ? params.provider : undefined);
  return {
    provider: canonicalProvider ?? params.provider,
    ...(runtimeOverride ? { runtimeOverride } : {}),
  };
}

/** Harness selection plus the CLI backend, when one owns this completion instead of a harness. */
export function resolveIsolatedCompletionRoute(params: {
  config: OpenClawConfig;
  /** Canonical model provider from resolveIsolatedCompletionProvider. */
  provider: string;
  model: string;
  authProfileId?: string;
  agentId: string;
  agentDir: string;
  workspaceDir: string;
  runtimeOverride?: string;
  /** Only a caller-supplied owner suppresses automatic CLI discovery. */
  explicitRuntimeOverride?: string;
}): { selection: AgentHarnessSelectionDecision; cliOwner?: string } {
  const selection = resolveAgentHarnessSelectionDecision({
    provider: params.provider,
    modelId: params.model,
    config: params.config,
    agentId: params.agentId,
    agentHarnessRuntimeOverride: params.runtimeOverride,
  });
  const runtime = params.runtimeOverride ?? selection.policy.runtime;
  if (isCliRuntimeAliasForProvider({ runtime, provider: params.provider, cfg: params.config })) {
    return { selection, cliOwner: runtime };
  }
  if (params.explicitRuntimeOverride) {
    // An explicit non-CLI owner is authoritative. Automatic CLI discovery must
    // not bypass that harness or turn its unsupported result into a fallback.
    return { selection };
  }
  const cliOwner =
    resolveCliRuntimeExecutionProvider({
      provider: params.provider,
      cfg: params.config,
      agentId: params.agentId,
      modelId: params.model,
      authProfileId: params.authProfileId,
    }) ??
    resolveEmbeddedCliBackendDispatchEligibility({
      provider: params.provider,
      model: params.model,
      agentId: params.agentId,
      authProfileId: params.authProfileId,
      config: params.config,
      agentDir: params.agentDir,
      workspaceDir: params.workspaceDir,
    })?.provider;
  return cliOwner ? { selection, cliOwner } : { selection };
}

/** How an isolated completion reaches its model, for provider-neutral route labels. */
export type IsolatedCompletionRuntime = {
  id: string;
  /** api: built-in HTTP runtime; cli: a CLI backend; harness: a plugin agent harness. */
  kind: "api" | "cli" | "harness";
  /** Display label a plugin harness declares for itself. */
  harnessLabel?: string;
};

/**
 * Runtime an isolated completion would execute on right now. Undefined when no
 * owner can serve the request.
 */
export function resolveIsolatedCompletionRuntime(
  params: IsolatedCompletionRouteParams,
): IsolatedCompletionRuntime | undefined {
  const config = params.config ?? {};
  try {
    const agentId = params.agentId ?? resolveDefaultAgentId(config);
    const { provider, runtimeOverride } = resolveIsolatedCompletionProvider({
      provider: params.provider,
      config,
      agentHarnessRuntimeOverride: params.agentHarnessRuntimeOverride,
    });
    const route = resolveIsolatedCompletionRoute({
      config,
      provider,
      model: params.model,
      authProfileId: params.authProfileId,
      agentId,
      agentDir: params.agentDir ?? resolveAgentDir(config, agentId),
      workspaceDir: params.workspaceDir ?? resolveAgentWorkspaceDir(config, agentId),
      runtimeOverride,
      explicitRuntimeOverride: params.agentHarnessRuntimeOverride,
    });
    if (route.cliOwner) {
      return { id: route.cliOwner, kind: "cli" };
    }
    const { harness, selectedHarnessId } = route.selection;
    if (!harness) {
      return { id: selectedHarnessId, kind: "api" };
    }
    // A plugin harness without isolated completion support fails the run.
    return harness.runIsolatedCompletionV2 || harness.runIsolatedCompletion
      ? { id: selectedHarnessId, kind: "harness", harnessLabel: harness.label }
      : undefined;
  } catch {
    // Status displays must not fail their response. Selection throws for a
    // pinned harness that is missing or unsupported; the completion would
    // fail too, so there is no route to report.
    return undefined;
  }
}
