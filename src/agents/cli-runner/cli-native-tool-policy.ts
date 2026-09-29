import { resolveSessionAgentIds } from "../agent-scope.js";
import { resolveExecDefaults } from "../exec-defaults.js";
import { resolvePluginHarnessToolPolicies } from "../harness/execution-environment.js";
import { resolveEffectiveToolFsWorkspaceOnly } from "../tool-fs-policy.js";
import type { PreparedCliRunContext } from "./types.js";

export function resolveCliNativeToolPolicy(context: PreparedCliRunContext) {
  const run = context.params;
  const policySessionKey = run.runtimePolicySessionKey ?? run.sessionKey;
  const policyAgentId = resolveSessionAgentIds({
    sessionKey: policySessionKey,
    config: run.config,
    fallbackAgentId: run.agentId,
  }).sessionAgentId;
  const permission = resolveExecDefaults({
    cfg: run.config,
    sessionEntry: policySessionKey === run.sessionKey ? run.sessionEntry : undefined,
    execOverrides: run.execOverrides,
    agentId: policyAgentId,
    sessionKey: policySessionKey,
  });
  const toolPolicies = resolvePluginHarnessToolPolicies({
    ...run,
    agentId: policyAgentId,
    sessionKey: policySessionKey,
    sandboxSessionKey: policySessionKey,
    sandboxAgentId: policyAgentId,
    provider: run.modelProvider ?? run.provider,
    modelId: context.modelId,
    preparedSessionEntry: policySessionKey === run.sessionKey ? run.sessionEntry : undefined,
  });
  return {
    permission,
    policySessionKey,
    policyAgentId,
    effectiveToolPolicies: [
      toolPolicies.senderPolicy,
      toolPolicies.senderScopedGroupPolicy,
      toolPolicies.groupPolicy,
      ...toolPolicies.runtimePolicies,
    ],
    fsWorkspaceOnly: resolveEffectiveToolFsWorkspaceOnly({
      cfg: run.config,
      agentId: policyAgentId,
    }),
  };
}
