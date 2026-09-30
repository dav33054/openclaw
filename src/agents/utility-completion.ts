import { formatAgentRuntimeName } from "../status/agent-runtime-label.js";
import { resolveIsolatedCompletionRuntime } from "./isolated-completion-route.js";
import { resolveSimpleCompletionSelectionForAgent } from "./simple-completion-runtime.js";

/** Keep visible-text retry/fallback in callers; the runtime owns authentication. */
export async function prepareUtilityCompletionForAgent(
  params: Parameters<typeof resolveSimpleCompletionSelectionForAgent>[0] & {
    preferredProfile?: string;
  },
) {
  const selection = resolveSimpleCompletionSelectionForAgent(params);
  if (!selection) {
    throw new Error(`No utility model configured for agent ${params.agentId}.`);
  }
  return {
    config: params.cfg,
    provider: selection.provider,
    model: selection.modelId,
    authProfileId: selection.profileId ?? params.preferredProfile,
    outputTextPolicy: "strict-visible" as const,
    agentId: params.agentId,
    agentDir: selection.agentDir,
  };
}

/** Provider-neutral route of a utility completion, as the Gateway reports it. */
export type UtilityCompletionRuntime = {
  id: string;
  kind: "api" | "cli" | "harness";
  label: string;
};

/**
 * Runtime the agent's utility completions would execute on, from the same
 * preparation and route decision they use. Undefined when utility routing is
 * disabled or no owner can serve it.
 */
export async function resolveUtilityCompletionRuntimeForAgent(
  params: Pick<
    Parameters<typeof resolveSimpleCompletionSelectionForAgent>[0],
    "cfg" | "agentId" | "manifestPlugins"
  >,
): Promise<UtilityCompletionRuntime | undefined> {
  let prepared: Awaited<ReturnType<typeof prepareUtilityCompletionForAgent>>;
  try {
    prepared = await prepareUtilityCompletionForAgent({ ...params, useUtilityModel: true });
  } catch {
    return undefined;
  }
  const runtime = resolveIsolatedCompletionRuntime(prepared);
  return (
    runtime && {
      id: runtime.id,
      kind: runtime.kind,
      label: formatAgentRuntimeName(runtime.id, runtime.harnessLabel),
    }
  );
}
