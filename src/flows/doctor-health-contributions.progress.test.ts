// Doctor health contribution progress tests cover human-readable lifecycle output.
import { describe, expect, it } from "vitest";
import { createDoctorHealthContribution } from "./doctor-health-contribution.js";
import {
  createDoctorHealthFlowContext,
  createDoctorPrompterFixture,
  runDoctorHealthContributionList,
} from "./doctor-health-contributions.test-support.js";

describe("doctor health contribution progress", () => {
  it("reports contribution start, outcome, and duration for human Doctor runs", async () => {
    const ctx = createDoctorHealthFlowContext({
      configPath: "/tmp/fake-openclaw.json",
      prompter: createDoctorPrompterFixture(),
    });
    const contribution = createDoctorHealthContribution({
      id: "doctor:test-progress",
      label: "Test progress",
      run: async () => undefined,
    });

    await runDoctorHealthContributionList(ctx, [contribution]);

    expect(ctx.runtime.log).toHaveBeenNthCalledWith(1, "Doctor: Test progress started");
    expect(ctx.runtime.log).toHaveBeenNthCalledWith(
      2,
      expect.stringMatching(/^Doctor: Test progress completed \(\d+ms\)$/),
    );
  });

  it("reports a warning when a contribution records a warning", async () => {
    const ctx = createDoctorHealthFlowContext({
      configPath: "/tmp/fake-openclaw.json",
      prompter: createDoctorPrompterFixture(),
    });
    const contribution = createDoctorHealthContribution({
      id: "doctor:test-warning",
      label: "Test warning",
      run: async (runCtx) => {
        runCtx.updateWarnings = ["test warning"];
      },
    });

    await runDoctorHealthContributionList(ctx, [contribution]);

    expect(ctx.runtime.log).toHaveBeenNthCalledWith(1, "Doctor: Test warning started");
    expect(ctx.runtime.log).toHaveBeenNthCalledWith(
      2,
      expect.stringMatching(/^Doctor: Test warning warning \(\d+ms\)$/),
    );
  });
});
