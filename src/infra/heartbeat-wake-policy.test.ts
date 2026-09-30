import { describe, expect, it } from "vitest";
import { isRealHeartbeatWake } from "./heartbeat-wake-policy.js";

describe("isRealHeartbeatWake", () => {
  it("returns true for undefined (ambient)", () => {
    expect(isRealHeartbeatWake(undefined)).toBe(true);
  });
  it("returns true for interval", () => {
    expect(isRealHeartbeatWake("interval")).toBe(true);
  });
  it("returns true for manual", () => {
    expect(isRealHeartbeatWake("manual")).toBe(true);
  });
  it.each([
    "exec-event",
    "cron",
    "hook",
    "background-task",
    "background-task-blocked",
    "acp-spawn",
    "session-state",
    "notifications-event",
    "restart-sentinel",
  ] as const)("returns false for %s", (source) => {
    expect(isRealHeartbeatWake(source)).toBe(false);
  });
});
