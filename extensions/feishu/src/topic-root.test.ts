import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ClawdbotConfig } from "../runtime-api.js";
import { resolveFeishuTopicRootMessageId } from "./send.js";

const { mockListMessages } = vi.hoisted(() => ({ mockListMessages: vi.fn() }));

vi.mock("./configured-client.js", () => ({
  createConfiguredFeishuClient: vi.fn(() => ({
    im: { message: { list: mockListMessages } },
  })),
}));

const cfg = {} as ClawdbotConfig;

describe("resolveFeishuTopicRootMessageId", () => {
  // Successful lookups are cached per topic, so each case uses its own topic id.
  beforeEach(() => {
    mockListMessages.mockReset();
  });

  it("resolves the topic's oldest message and reuses it for later sends", async () => {
    mockListMessages.mockResolvedValue({
      code: 0,
      data: { items: [{ message_id: "om_topic_root" }] },
    });

    await expect(resolveFeishuTopicRootMessageId({ cfg, topicId: "omt_topic" })).resolves.toBe(
      "om_topic_root",
    );
    await expect(resolveFeishuTopicRootMessageId({ cfg, topicId: "omt_topic" })).resolves.toBe(
      "om_topic_root",
    );

    expect(mockListMessages).toHaveBeenCalledTimes(1);
    expect(mockListMessages).toHaveBeenCalledWith({
      params: {
        container_id_type: "thread",
        container_id: "omt_topic",
        sort_type: "ByCreateTimeAsc",
        page_size: 1,
      },
    });
  });

  it("returns undefined without a lookup when the turn has no topic", async () => {
    await expect(resolveFeishuTopicRootMessageId({ cfg, topicId: "  " })).resolves.toBeUndefined();
    await expect(resolveFeishuTopicRootMessageId({ cfg })).resolves.toBeUndefined();

    expect(mockListMessages).not.toHaveBeenCalled();
  });

  it("stays best-effort when the topic lookup fails", async () => {
    mockListMessages.mockResolvedValue({ code: 99_991, msg: "invalid container" });
    await expect(
      resolveFeishuTopicRootMessageId({ cfg, topicId: "omt_bad" }),
    ).resolves.toBeUndefined();

    mockListMessages.mockRejectedValue(new Error("network down"));
    await expect(
      resolveFeishuTopicRootMessageId({ cfg, topicId: "omt_unreachable" }),
    ).resolves.toBeUndefined();

    mockListMessages.mockResolvedValue({ code: 0, data: { items: [] } });
    await expect(
      resolveFeishuTopicRootMessageId({ cfg, topicId: "omt_empty" }),
    ).resolves.toBeUndefined();
  });
});
