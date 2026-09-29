import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { listAgentIds } from "../agent-scope-config.js";
import { describeAcpSpawnTargetParameter } from "../subagents/spawn/acp-spawn-target.js";
import {
  isSubagentEnvelopeSession,
  resolveSubagentCapabilityStore,
} from "../subagents/spawn/subagent-capabilities.js";
import {
  describeSubagentSpawnTargetParameter,
  resolveSubagentSpawnTargetConfig,
} from "../subagents/spawn/subagent-target-policy.js";

/** Describe the `sessions_spawn` `agentId` parameter for the requester's admitted targets. */
export function describeSessionsSpawnAgentId(params: {
  cfg: OpenClawConfig;
  requesterAgentId?: string;
  agentSessionKey?: string;
  acpAvailable: boolean;
  collectDefaultAgentId?: string;
}): string {
  const requesterAgentId = params.requesterAgentId ?? "";
  const native = describeSubagentSpawnTargetParameter({
    requesterAgentId,
    ...resolveSubagentSpawnTargetConfig(params.cfg, requesterAgentId),
    configuredAgentIds: listAgentIds(params.cfg),
    collectDefaultAgentId: params.collectDefaultAgentId,
  });
  if (!params.acpAvailable) {
    return native;
  }
  // Same classification as ACP spawn admission, so guidance matches what it accepts.
  const subagentRequesterId = isSubagentEnvelopeSession(params.agentSessionKey, {
    cfg: params.cfg,
    store: resolveSubagentCapabilityStore(params.agentSessionKey, { cfg: params.cfg }),
  })
    ? requesterAgentId
    : undefined;
  return `With runtime="subagent" (default): ${native} With runtime="acp": ${describeAcpSpawnTargetParameter(params.cfg, subagentRequesterId)}`;
}
