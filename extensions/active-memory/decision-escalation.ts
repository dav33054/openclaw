import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type {
  DecisionBatch,
  DecisionOutcome,
  DecisionRuntimeV1,
  UnavailableReason,
} from "openclaw/plugin-sdk/decisions";
import type { RecallEscalationDecider } from "./escalation.js";

export const ACTIVE_MEMORY_ESCALATION_DECISION_PURPOSE = "active-memory/escalation";
export const ACTIVE_MEMORY_ESCALATION_RUBRIC_VERSION = "active-memory-escalation/1";
const DEEP_RECALL_QUESTION_ID = "deepRecall";
const RECALL_PROBABILITY_THRESHOLD = 0.5;
/** Live-consent recheck cadence while a Decision evaluation is pending. */
export const ACTIVE_MEMORY_DECISION_CONSENT_POLL_MS = 10;

const DEEP_RECALL_QUESTION = {
  type: "boolean",
  instructions:
    "Decide whether answering the latest user message needs a search of earlier conversations or saved memory beyond the current turn.",
  criteria: {
    true: "The user refers to earlier conversations, prior decisions, stated preferences, or facts shared in past sessions.",
    false:
      "The message can be answered from the current turn alone, or it only concerns new or future work.",
  },
} as const;

/**
 * Mirrors the host's outer eligibility for automatic Decision consumers: the
 * default-off Decision assistance setting. The shared runtime separately
 * reports "disabled" when the owning agent has no Decision model selected.
 */
export function isActiveMemoryDecisionEscalationEligible(config: OpenClawConfig): boolean {
  return config.agents?.defaults?.experimental?.decisionAssistance === true;
}

export function buildActiveMemoryEscalationDecisionBatch(params: {
  message: string;
  searchQuery: string;
}): DecisionBatch {
  return {
    state: {
      latestUserMessage: params.message,
      searchQuery: params.searchQuery,
    },
    questions: { [DEEP_RECALL_QUESTION_ID]: DEEP_RECALL_QUESTION },
  };
}

export type ActiveMemoryDecisionAbstainReason = UnavailableReason | "invalid-answer" | "revoked";

export function mapActiveMemoryEscalationDecisionOutcome(
  outcome: DecisionOutcome,
):
  | { result: "recall" | "skip" }
  | { result: "abstain"; reason: ActiveMemoryDecisionAbstainReason } {
  if (outcome.status !== "ok") {
    return { result: "abstain", reason: outcome.reason };
  }
  const answer = outcome.result.answers[DEEP_RECALL_QUESTION_ID];
  if (
    answer?.type !== "boolean" ||
    !Number.isFinite(answer.probabilityTrue) ||
    answer.probabilityTrue < 0 ||
    answer.probabilityTrue > 1
  ) {
    return { result: "abstain", reason: "invalid-answer" };
  }
  return { result: answer.probabilityTrue >= RECALL_PROBABILITY_THRESHOLD ? "recall" : "skip" };
}

/**
 * Asks the owning agent's Decision model whether this turn needs deep recall.
 * Unavailable or unusable answers abstain so the built-in matcher decides.
 */
export function createActiveMemoryDecisionEscalationDecider(params: {
  decisions: Pick<DecisionRuntimeV1, "evaluate">;
  agentId: string;
  /**
   * Reads live consent. It is checked before evaluation, continuously while
   * the shared runtime prepares and dispatches, and again before the answer is
   * used, so a revoked opt-in never lets turn evidence reach a hosted Decision
   * model or lets a late answer steer recall.
   */
  isStillAllowed: () => boolean;
  onAbstain?: (reason: ActiveMemoryDecisionAbstainReason) => void;
  /** Consent poll interval while evaluation is pending. */
  consentPollMs?: number;
}): RecallEscalationDecider {
  const pollMs = params.consentPollMs ?? ACTIVE_MEMORY_DECISION_CONSENT_POLL_MS;
  const revoked = (): "abstain" => {
    params.onAbstain?.("revoked");
    return "abstain";
  };
  return {
    async decide({ message, searchQuery, signal, timeoutMs }) {
      if (!params.isStillAllowed()) {
        return revoked();
      }
      // The runtime checks this signal immediately before provider I/O and
      // hands it to the provider, so aborting it on revocation fences dispatch.
      const consent = new AbortController();
      const poll = setInterval(() => {
        if (!params.isStillAllowed()) {
          consent.abort();
        }
      }, pollMs);
      try {
        let outcome: DecisionOutcome;
        try {
          outcome = await params.decisions.evaluate(
            buildActiveMemoryEscalationDecisionBatch({ message, searchQuery }),
            {
              agentId: params.agentId,
              purpose: ACTIVE_MEMORY_ESCALATION_DECISION_PURPOSE,
              rubricVersion: ACTIVE_MEMORY_ESCALATION_RUBRIC_VERSION,
              timeoutMs,
              signal: AbortSignal.any([signal, consent.signal]),
            },
          );
        } catch (error) {
          if (consent.signal.aborted) {
            return revoked();
          }
          throw error;
        }
        if (consent.signal.aborted || !params.isStillAllowed()) {
          return revoked();
        }
        const mapped = mapActiveMemoryEscalationDecisionOutcome(outcome);
        if (mapped.result === "abstain") {
          params.onAbstain?.(mapped.reason);
        }
        return mapped.result;
      } finally {
        clearInterval(poll);
      }
    },
  };
}
