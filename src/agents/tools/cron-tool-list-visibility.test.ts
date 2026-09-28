import { expect, it } from "vitest";
import { createCronTool } from "./cron-tool.js";

it("describes scoped cron lists without excluding authenticated owner inventories", () => {
  const tool = createCronTool();

  expect(tool.description).toContain(
    "Authenticated configured channel owner and Control UI administrator turns can list/get/update/run/remove any Gateway automation",
  );
  expect(tool.description).toContain(
    "Other turns see only caller-visible jobs; total, snapshotRevision, offset, limit, nextOffset, and hasMore describe that scoped view, not the complete Gateway inventory",
  );
  expect(tool.description).not.toContain(
    "In an agent session, list results are restricted to automations visible to the calling agent",
  );
});
