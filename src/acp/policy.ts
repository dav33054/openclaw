import type { OpenClawConfig } from "../config/types.openclaw.js";
import { normalizeAgentId } from "../routing/session-key.js";
/** Policy gates for ACP availability, dispatch, and allowed agent ids. */
import { AcpRuntimeError } from "./runtime/errors.js";

const ACP_DISABLED_MESSAGE = "ACP is disabled by policy (`acp.enabled=false`).";
const ACP_DISPATCH_DISABLED_MESSAGE =
  "ACP dispatch is disabled by policy (`acp.dispatch.enabled=false`).";

/** Returns whether ACP is globally enabled by config policy. */
export function isAcpEnabledByPolicy(cfg: OpenClawConfig): boolean {
  return cfg.acp?.enabled !== false;
}

/** Returns the operator-facing dispatch block message, if any. */
export function resolveAcpDispatchPolicyMessage(cfg: OpenClawConfig): string | null {
  if (!isAcpEnabledByPolicy(cfg)) {
    return ACP_DISABLED_MESSAGE;
  }
  return cfg.acp?.dispatch?.enabled === false ? ACP_DISPATCH_DISABLED_MESSAGE : null;
}

/** Returns the runtime error for dispatch-blocked ACP routing, if blocked. */
export function resolveAcpDispatchPolicyError(cfg: OpenClawConfig): AcpRuntimeError | null {
  const message = resolveAcpDispatchPolicyMessage(cfg);
  if (!message) {
    return null;
  }
  return new AcpRuntimeError("ACP_DISPATCH_DISABLED", message);
}

/** Returns the runtime error for explicit ACP turns when ACP itself is disabled. */
export function resolveAcpExplicitTurnPolicyError(cfg: OpenClawConfig): AcpRuntimeError | null {
  if (isAcpEnabledByPolicy(cfg)) {
    return null;
  }
  return new AcpRuntimeError("ACP_DISPATCH_DISABLED", ACP_DISABLED_MESSAGE);
}

function listAcpAllowedAgentIds(cfg: OpenClawConfig): string[] {
  return (cfg.acp?.allowedAgents ?? []).map((entry) => normalizeAgentId(entry)).filter(Boolean);
}

/** Returns whether `acp.allowedAgents` restricts ACP target ids. */
export function hasAcpAgentAllowlist(cfg: OpenClawConfig): boolean {
  return listAcpAllowedAgentIds(cfg).length > 0;
}

/** Returns whether an agent id passes the optional ACP allowed-agent list. */
function isAcpAgentAllowedByPolicy(cfg: OpenClawConfig, agentId: string): boolean {
  return (
    !hasAcpAgentAllowlist(cfg) || listAcpAllowedAgentIds(cfg).includes(normalizeAgentId(agentId))
  );
}

/** Returns the runtime error for agent-policy rejection, if rejected. */
export function resolveAcpAgentPolicyError(
  cfg: OpenClawConfig,
  agentId: string,
): AcpRuntimeError | null {
  if (isAcpAgentAllowedByPolicy(cfg, agentId)) {
    return null;
  }
  return new AcpRuntimeError(
    "ACP_SESSION_INIT_FAILED",
    `ACP agent "${normalizeAgentId(agentId)}" is not allowed by policy.`,
  );
}
