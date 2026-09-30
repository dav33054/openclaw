import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { DecisionOutcome } from "openclaw/plugin-sdk/decisions";
import { describe, expect, it, vi } from "vitest";
import {
  ACTIVE_MEMORY_ESCALATION_DECISION_PURPOSE,
  ACTIVE_MEMORY_ESCALATION_RUBRIC_VERSION,
  buildActiveMemoryEscalationDecisionBatch,
  createActiveMemoryDecisionEscalationDecider,
  isActiveMemoryDecisionEscalationEligible,
  mapActiveMemoryEscalationDecisionOutcome,
} from "./decision-escalation.js";

function booleanOutcome(probabilityTrue: number): DecisionOutcome {
  return {
    status: "ok",
    result: {
      model: "test/decider",
      answers: { deepRecall: { type: "boolean", probabilityTrue } },
    },
    provenance: {
      providerId: "test",
      rubricVersion: ACTIVE_MEMORY_ESCALATION_RUBRIC_VERSION,
      runtimeGeneration: "generation-1",
    },
  };
}

describe("active-memory decision escalation", () => {
  it("asks one boolean deep-recall question over the bounded message and search query", () => {
    expect(
      buildActiveMemoryEscalationDecisionBatch({
        message: "What did we decide last time?",
        searchQuery: "earlier turn\nWhat did we decide last time?",
      }),
    ).toEqual({
      state: {
        latestUserMessage: "What did we decide last time?",
        searchQuery: "earlier turn\nWhat did we decide last time?",
      },
      questions: {
        deepRecall: {
          type: "boolean",
          instructions: expect.any(String),
          criteria: { true: expect.any(String), false: expect.any(String) },
        },
      },
    });
  });

  it.each([
    [1, "recall"],
    [0.5, "recall"],
    [0.49, "skip"],
    [0, "skip"],
  ] as const)("maps probabilityTrue=%s to %s", (probabilityTrue, expected) => {
    expect(mapActiveMemoryEscalationDecisionOutcome(booleanOutcome(probabilityTrue))).toEqual({
      result: expected,
    });
  });

  it.each([
    ["an out-of-range probability", booleanOutcome(1.5)],
    ["a non-finite probability", booleanOutcome(Number.NaN)],
    [
      "a missing answer",
      { ...booleanOutcome(1), result: { model: "test/decider", answers: {} } } as DecisionOutcome,
    ],
    [
      "a non-boolean answer",
      {
        ...booleanOutcome(1),
        result: {
          model: "test/decider",
          answers: { deepRecall: { type: "score", score: 1, probabilities: [0, 1] } },
        },
      } as DecisionOutcome,
    ],
  ])("abstains on %s", (_label, outcome) => {
    expect(mapActiveMemoryEscalationDecisionOutcome(outcome)).toEqual({
      result: "abstain",
      reason: "invalid-answer",
    });
  });

  it.each(["disabled", "not-configured", "deadline", "rate-limited", "transport"] as const)(
    "abstains with the runtime's %s reason",
    (reason) => {
      expect(mapActiveMemoryEscalationDecisionOutcome({ status: "unavailable", reason })).toEqual({
        result: "abstain",
        reason,
      });
    },
  );

  it("evaluates through the owning agent with the Active Memory purpose, rubric, and budget", async () => {
    const evaluate = vi.fn(async () => booleanOutcome(0.9));
    const caller = new AbortController();
    const signal = caller.signal;
    const decider = createActiveMemoryDecisionEscalationDecider({
      decisions: { evaluate },
      agentId: "main",
      isStillAllowed: () => true,
    });

    await expect(
      decider.decide({
        message: "Explain the current configuration",
        searchQuery: "Explain the current configuration",
        signal,
        timeoutMs: 750,
      }),
    ).resolves.toBe("recall");
    expect(evaluate).toHaveBeenCalledWith(
      buildActiveMemoryEscalationDecisionBatch({
        message: "Explain the current configuration",
        searchQuery: "Explain the current configuration",
      }),
      {
        agentId: "main",
        purpose: ACTIVE_MEMORY_ESCALATION_DECISION_PURPOSE,
        rubricVersion: ACTIVE_MEMORY_ESCALATION_RUBRIC_VERSION,
        timeoutMs: 750,
        signal: expect.any(AbortSignal),
      },
    );
    // The runtime receives a consent-fenced signal that still follows the caller.
    const passed = (evaluate.mock.calls[0] as unknown[] | undefined)?.[1] as {
      signal: AbortSignal;
    };
    expect(passed.signal.aborted).toBe(false);
    caller.abort();
    expect(passed.signal.aborted).toBe(true);
  });

  it("reports why an unavailable decision abstains", async () => {
    const onAbstain = vi.fn();
    const decider = createActiveMemoryDecisionEscalationDecider({
      decisions: { evaluate: async () => ({ status: "unavailable", reason: "disabled" }) },
      agentId: "main",
      isStillAllowed: () => true,
      onAbstain,
    });

    await expect(
      decider.decide({
        message: "What did we decide last time?",
        searchQuery: "What did we decide last time?",
        signal: new AbortController().signal,
        timeoutMs: 100,
      }),
    ).resolves.toBe("abstain");
    expect(onAbstain).toHaveBeenCalledWith("disabled");
  });

  it("does not evaluate when consent was revoked after the hook started", async () => {
    const evaluate = vi.fn(async () => booleanOutcome(1));
    const onAbstain = vi.fn();
    const decider = createActiveMemoryDecisionEscalationDecider({
      decisions: { evaluate },
      agentId: "main",
      isStillAllowed: () => false,
      onAbstain,
    });

    await expect(
      decider.decide({
        message: "What did we decide last time?",
        searchQuery: "What did we decide last time?",
        signal: new AbortController().signal,
        timeoutMs: 100,
      }),
    ).resolves.toBe("abstain");
    expect(evaluate).not.toHaveBeenCalled();
    expect(onAbstain).toHaveBeenCalledWith("revoked");
  });

  describe("live consent fence", () => {
    const decideRetrospective = (
      decider: ReturnType<typeof createActiveMemoryDecisionEscalationDecider>,
    ) =>
      decider.decide({
        message: "What did we decide last time?",
        searchQuery: "What did we decide last time?",
        signal: new AbortController().signal,
        timeoutMs: 1_000,
      });

    it("does not dispatch when consent is revoked while the runtime prepares", async () => {
      vi.useFakeTimers();
      try {
        let allowed = true;
        let dispatched = false;
        const onAbstain = vi.fn();
        const evaluate = vi.fn(async (_batch: unknown, options: { signal: AbortSignal }) => {
          // Operator preparation awaits before the runtime's final pre-dispatch check.
          await new Promise((resolve) => {
            setTimeout(resolve, 50);
          });
          options.signal.throwIfAborted();
          dispatched = true;
          return booleanOutcome(1);
        });
        const decider = createActiveMemoryDecisionEscalationDecider({
          decisions: { evaluate },
          agentId: "main",
          isStillAllowed: () => allowed,
          onAbstain,
        });

        const pending = decideRetrospective(decider);
        await vi.advanceTimersByTimeAsync(20);
        allowed = false;
        await vi.advanceTimersByTimeAsync(60);

        await expect(pending).resolves.toBe("abstain");
        expect(evaluate).toHaveBeenCalledOnce();
        expect(dispatched).toBe(false);
        expect(onAbstain).toHaveBeenCalledWith("revoked");
        expect(vi.getTimerCount()).toBe(0);
      } finally {
        vi.useRealTimers();
      }
    });

    it("ignores an answer when consent is revoked during inference", async () => {
      vi.useFakeTimers();
      try {
        let allowed = true;
        const onAbstain = vi.fn();
        const evaluate = vi.fn(async () => {
          // Already dispatched; this provider ignores cancellation and still answers.
          await new Promise((resolve) => {
            setTimeout(resolve, 50);
          });
          return booleanOutcome(1);
        });
        const decider = createActiveMemoryDecisionEscalationDecider({
          decisions: { evaluate },
          agentId: "main",
          isStillAllowed: () => allowed,
          onAbstain,
        });

        const pending = decideRetrospective(decider);
        await vi.advanceTimersByTimeAsync(20);
        allowed = false;
        await vi.advanceTimersByTimeAsync(60);

        await expect(pending).resolves.toBe("abstain");
        expect(onAbstain).toHaveBeenCalledWith("revoked");
        expect(vi.getTimerCount()).toBe(0);
      } finally {
        vi.useRealTimers();
      }
    });

    it("uses the answer and stops polling when consent holds", async () => {
      vi.useFakeTimers();
      try {
        const isStillAllowed = vi.fn(() => true);
        const decider = createActiveMemoryDecisionEscalationDecider({
          decisions: {
            evaluate: async () => {
              await new Promise((resolve) => {
                setTimeout(resolve, 50);
              });
              return booleanOutcome(0.2);
            },
          },
          agentId: "main",
          isStillAllowed,
        });

        const pending = decideRetrospective(decider);
        await vi.advanceTimersByTimeAsync(60);

        await expect(pending).resolves.toBe("skip");
        expect(isStillAllowed.mock.calls.length).toBeGreaterThan(2);
        expect(vi.getTimerCount()).toBe(0);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  it.each([
    [undefined, false],
    [false, false],
    [true, true],
  ] as const)("treats decisionAssistance=%s as eligible=%s", (decisionAssistance, expected) => {
    const config = {
      agents: { defaults: { experimental: { decisionAssistance } } },
    } as OpenClawConfig;
    expect(isActiveMemoryDecisionEscalationEligible(config)).toBe(expected);
    expect(isActiveMemoryDecisionEscalationEligible({} as OpenClawConfig)).toBe(false);
  });
});
