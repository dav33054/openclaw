import {
  readyArtifactName,
  validateReleaseButtonInputs,
} from "../../scripts/openclaw-release-ready.mjs";

export const REPOSITORY = "openclaw/openclaw";
export const SOURCE_SHA = "a".repeat(40);
export const TOOLING_SHA = "b".repeat(40);
export const TOOLING = {
  ref: `release-publish/${TOOLING_SHA.slice(0, 12)}-123`,
  fullRef: `refs/tags/release-publish/${TOOLING_SHA.slice(0, 12)}-123`,
  sha: TOOLING_SHA,
};

export function inputs(overrides: Record<string, unknown> = {}) {
  return {
    tag: "v2026.9.2-beta.1",
    npm_dist_tag: "beta",
    preflight_run_id: "100",
    full_release_validation_run_id: "200",
    full_release_validation_run_attempt: "1",
    ...overrides,
  };
}

export function descriptor(target: "npm" | "clawhub") {
  return {
    repository: REPOSITORY,
    runId: target === "npm" ? 300 : 400,
    runAttempt: 1,
    workflowPath: `.github/workflows/plugin-${target}-release.yml`,
    workflowEvent: "workflow_dispatch",
    workflowHeadBranch: TOOLING.ref,
    workflowSha: TOOLING_SHA,
    artifactId: target === "npm" ? 500 : 600,
    artifactName: `prepared-${target}`,
    artifactDigest: `sha256:${"c".repeat(64)}`,
    artifactSizeBytes: 100,
  };
}

export function readyRelease() {
  return {
    schema: "openclaw.release-ready/v1",
    repository: REPOSITORY,
    sourceSha: SOURCE_SHA,
    tooling: { ...TOOLING },
    inputs: validateReleaseButtonInputs(inputs()),
    plugins: { npm: descriptor("npm"), clawhub: descriptor("clawhub") },
  };
}

export function readinessDescriptor() {
  return {
    ...descriptor("npm"),
    workflowPath: ".github/workflows/openclaw-release-prepare.yml",
    artifactName: readyArtifactName(SOURCE_SHA, 300, 1),
  };
}

export function publicationRequest(ready = readyRelease(), resumeRunId = "") {
  const effectiveInputs = {
    ...ready.inputs,
    ...(resumeRunId ? { openclaw_npm_resume_run_id: resumeRunId } : {}),
    prepared_plugins: JSON.stringify(ready.plugins),
  };
  return {
    schema: "openclaw.release-dispatch/v1",
    repository: REPOSITORY,
    workflowPath: ".github/workflows/openclaw-release-publish.yml",
    workflowEvent: "workflow_dispatch",
    state: "acknowledged",
    button: { runId: 900, runAttempt: 1 },
    expectedReleaseRunAttempt: 1,
    releaseRunId: 700,
    releaseRunAttempt: 1,
    producer: {
      repository: REPOSITORY,
      runId: 700,
      runAttempt: 1,
      workflowPath: ".github/workflows/openclaw-release-publish.yml",
      workflowEvent: "workflow_dispatch",
      workflowHeadBranch: TOOLING.ref,
      workflowSha: TOOLING_SHA,
    },
    sourceSha: ready.sourceSha,
    tooling: TOOLING,
    preparedArtifact: readinessDescriptor(),
    inputs: effectiveInputs,
    openclawNpmResumeRunId: effectiveInputs.openclaw_npm_resume_run_id ?? null,
  };
}
