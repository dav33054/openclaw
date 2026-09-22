// Msteams tests cover messenger plugin behavior.
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { PlatformMessageNotDispatchedError } from "openclaw/plugin-sdk/error-runtime";
import { SILENT_REPLY_TOKEN } from "openclaw/plugin-sdk/reply-chunking";
import type { PluginRuntime } from "openclaw/plugin-sdk/runtime-store";
import { resolvePreferredOpenClawTmpDir } from "openclaw/plugin-sdk/temp-path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { StoredConversationReference } from "./conversation-store.js";
import { teamsMarkdownDeliveryCases } from "./format.test-fixtures.js";
const graphUploadMockState = vi.hoisted(() => ({
  uploadAndShareSharePoint: vi.fn(),
  getDriveItemProperties: vi.fn(),
  resolveUploadSiteId: vi.fn(),
}));

vi.mock("./graph-upload.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./graph-upload.js")>();
  graphUploadMockState.resolveUploadSiteId.mockImplementation(async (params) => {
    const explicit = params.configuredSiteId?.trim();
    if (explicit) {
      return explicit;
    }
    throw new Error("No SharePoint site ID available for file upload.");
  });
  return {
    ...actual,
    uploadAndShareSharePoint: graphUploadMockState.uploadAndShareSharePoint,
    getDriveItemProperties: graphUploadMockState.getDriveItemProperties,
    resolveUploadSiteId: graphUploadMockState.resolveUploadSiteId,
  };
});

import {
  buildConversationReference,
  renderReplyPayloadsToMessages,
  sendMSTeamsMessages,
} from "./messenger.js";
import { createMockApp } from "./messenger.test-helpers.js";
import { setMSTeamsRuntime } from "./runtime.js";

const chunkMarkdownText = (text: string, limit: number) => {
  if (!text) {
    return [];
  }
  if (limit <= 0 || text.length <= limit) {
    return [text];
  }
  const chunks: string[] = [];
  for (let index = 0; index < text.length; index += limit) {
    chunks.push(text.slice(index, index + limit));
  }
  return chunks;
};

const runtimeStub = {
  config: {
    loadConfig: () => ({}),
  },
  channel: {
    text: {
      chunkMarkdownText,
      chunkMarkdownTextWithMode: chunkMarkdownText,
      resolveMarkdownTableMode: () => "code",
      convertMarkdownTables: (text: string) => text,
    },
  },
} as unknown as PluginRuntime;

const createRecordedSendActivity = (
  sink: string[],
  failFirstWithStatusCode?: number,
): ((activity: unknown) => Promise<{ id: string }>) => {
  let attempts = 0;
  return async (activity: unknown) => {
    const { text } = activity as { text?: string };
    const content = text ?? "";
    sink.push(content);
    attempts += 1;
    if (failFirstWithStatusCode !== undefined && attempts === 1) {
      throw Object.assign(new Error("send failed"), { statusCode: failFirstWithStatusCode });
    }
    return { id: `id:${content}` };
  };
};

const REVOCATION_ERROR = "Cannot perform 'set' on a proxy that has been revoked";

function findEntity(
  entities: unknown,
  predicate: (entity: Record<string, unknown>) => boolean,
): Record<string, unknown> | undefined {
  return (entities as Array<Record<string, unknown>> | undefined)?.find(predicate);
}

function requireAiGeneratedEntity(entities: unknown): Record<string, unknown> {
  const entity = findEntity(
    entities,
    (candidate) =>
      Array.isArray(candidate.additionalType) &&
      candidate.additionalType.includes("AIGeneratedContent"),
  );
  if (!entity) {
    throw new Error("expected Teams AI-generated entity");
  }
  return entity;
}

async function buildActivity(
  message: Parameters<typeof sendMSTeamsMessages>[0]["messages"][number],
  conversationRef: StoredConversationReference,
  tokenProvider?: Parameters<typeof sendMSTeamsMessages>[0]["tokenProvider"],
  sharePointSiteId?: string,
  mediaMaxBytes?: number,
  options?: { feedbackLoopEnabled?: boolean },
): Promise<Record<string, unknown>> {
  let captured: Record<string, unknown> | undefined;
  const app = createMockApp({
    createFn: async (activity) => {
      captured = activity as Record<string, unknown>;
      return { id: "captured" };
    },
  });
  await sendMSTeamsMessages({
    replyStyle: "top-level",
    app,
    appId: "app123",
    conversationRef,
    messages: [message],
    tokenProvider,
    sharePointSiteId,
    mediaMaxBytes,
    feedbackLoopEnabled: options?.feedbackLoopEnabled,
  });
  if (!captured) {
    throw new Error("expected Teams activity to be sent");
  }
  return captured;
}

describe("msteams messenger", () => {
  beforeEach(() => {
    setMSTeamsRuntime(runtimeStub);
    graphUploadMockState.uploadAndShareSharePoint.mockReset();
    graphUploadMockState.getDriveItemProperties.mockReset();
    graphUploadMockState.resolveUploadSiteId.mockReset();
    graphUploadMockState.resolveUploadSiteId.mockImplementation(async (params) => {
      const explicit = params.configuredSiteId?.trim();
      if (explicit) {
        return explicit;
      }
      throw new Error("No SharePoint site ID available for file upload.");
    });
  });

  describe("renderReplyPayloadsToMessages", () => {
    it("filters silent replies", () => {
      const messages = renderReplyPayloadsToMessages([{ text: SILENT_REPLY_TOKEN }], {
        textChunkLimit: 4000,
        tableMode: "code",
      });
      expect(messages).toStrictEqual([]);
    });

    it("does not filter non-exact silent reply prefixes", () => {
      const messages = renderReplyPayloadsToMessages(
        [{ text: `${SILENT_REPLY_TOKEN} -- ignored` }],
        { textChunkLimit: 4000, tableMode: "code" },
      );
      expect(messages).toEqual([{ text: `${SILENT_REPLY_TOKEN} -- ignored` }]);
    });

    it("splits media into separate messages by default", () => {
      const messages = renderReplyPayloadsToMessages(
        [{ text: "hi", mediaUrl: "https://example.com/a.png" }],
        { textChunkLimit: 4000, tableMode: "code" },
      );
      expect(messages).toEqual([{ text: "hi" }, { mediaUrl: "https://example.com/a.png" }]);
    });

    it("supports inline media mode", () => {
      const messages = renderReplyPayloadsToMessages(
        [{ text: "hi", mediaUrl: "https://example.com/a.png" }],
        { textChunkLimit: 4000, mediaMode: "inline", tableMode: "code" },
      );
      expect(messages).toEqual([{ text: "hi", mediaUrl: "https://example.com/a.png" }]);
    });

    it("chunks long text when enabled", () => {
      const long = "hello ".repeat(200);
      const messages = renderReplyPayloadsToMessages([{ text: long }], {
        textChunkLimit: 50,
        tableMode: "code",
      });
      expect(messages.length).toBeGreaterThan(1);
    });
  });

  describe("sendMSTeamsMessages", () => {
    function createRevokedThreadContext(params?: { failAfterAttempt?: number; sent?: string[] }) {
      let attempt = 0;
      return {
        sendActivity: async (activity: unknown) => {
          const { text } = activity as { text?: string };
          const content = text ?? "";
          attempt += 1;
          if (params?.failAfterAttempt && attempt < params.failAfterAttempt) {
            params.sent?.push(content);
            return { id: `id:${content}` };
          }
          throw new TypeError(REVOCATION_ERROR);
        },
      };
    }

    const baseRef: StoredConversationReference = {
      activityId: "activity123",
      user: { id: "user123", name: "User" },
      agent: { id: "bot123", name: "Bot" },
      conversation: { id: "19:abc@thread.tacv2;messageid=deadbeef" },
      channelId: "msteams",
      serviceUrl: "https://smba.trafficmanager.net/amer/",
    };

    async function sendAndCaptureRevokeFallbackReference(params: {
      conversation: StoredConversationReference["conversation"];
      activityId?: string;
      threadId?: string;
    }) {
      const proactiveSent: string[] = [];
      let capturedConversationId: string | undefined;
      const conversationRef: StoredConversationReference = {
        activityId: params.activityId ?? "activity456",
        user: { id: "user123", name: "User" },
        agent: { id: "bot123", name: "Bot" },
        conversation: params.conversation,
        channelId: "msteams",
        serviceUrl: "https://smba.trafficmanager.net/amer/",
        ...(params.threadId ? { threadId: params.threadId } : {}),
      };

      await sendMSTeamsMessages({
        replyStyle: "thread",
        app: createMockApp({
          createFn: createRecordedSendActivity(proactiveSent),
          onClientCreated: (_serviceUrl, conversationId) => {
            capturedConversationId = conversationId;
          },
        }),
        appId: "app123",
        conversationRef,
        context: createRevokedThreadContext(),
        messages: [{ text: "hello" }],
      });

      return {
        proactiveSent,
        // Reconstruct a reference-like shape from captured conversationId for assertion compat
        reference: {
          conversation: capturedConversationId ? { id: capturedConversationId } : undefined,
          activityId: undefined,
        },
      };
    }

    it("sends thread messages via the provided context", async () => {
      const sent: string[] = [];
      const ctx = {
        sendActivity: createRecordedSendActivity(sent),
      };
      const ids = await sendMSTeamsMessages({
        replyStyle: "thread",
        app: createMockApp(),
        appId: "app123",
        conversationRef: baseRef,
        context: ctx,
        messages: [{ text: "one" }, { text: "two" }],
      });

      expect(sent).toEqual(["one", "two"]);
      expect(ids).toEqual(["id:one", "id:two"]);
    });

    it.each(teamsMarkdownDeliveryCases)(
      "sends $name via proactive send context",
      async ({ source, expected }) => {
        const texts: string[] = [];
        let capturedConversationId: string | undefined;

        const ids = await sendMSTeamsMessages({
          replyStyle: "top-level",
          app: createMockApp({
            createFn: createRecordedSendActivity(texts),
            onClientCreated: (_serviceUrl, conversationId) => {
              capturedConversationId = conversationId;
            },
          }),
          appId: "app123",
          conversationRef: baseRef,
          messages: renderReplyPayloadsToMessages([{ text: source }], {
            textChunkLimit: 4000,
            tableMode: "off",
          }),
        });

        expect(texts).toEqual([expected]);
        expect(ids).toEqual([`id:${expected}`]);
        expect(capturedConversationId).toBe("19:abc@thread.tacv2");
      },
    );

    it("requires SharePoint storage for channel files", async () => {
      const tmpDir = await mkdtemp(path.join(resolvePreferredOpenClawTmpDir(), "msteams-storage-"));
      const localFile = path.join(tmpDir, "note.txt");
      await writeFile(localFile, "hello");

      try {
        await expect(
          sendMSTeamsMessages({
            replyStyle: "thread",
            app: createMockApp(),
            appId: "app123",
            conversationRef: {
              ...baseRef,
              conversation: {
                ...baseRef.conversation,
                conversationType: "channel",
              },
            },
            messages: [{ text: "one", mediaUrl: localFile }],
            tokenProvider: { getAccessToken: async () => "token" },
          }),
        ).rejects.toThrow("No SharePoint site ID available");
      } finally {
        await rm(tmpDir, { recursive: true, force: true });
      }
    });

    it("marks local activity preparation failures as never dispatched", async () => {
      const sendActivity = vi.fn(async () => ({ id: "should-not-send" }));
      const missingPath = path.join(resolvePreferredOpenClawTmpDir(), "missing-msteams-file.txt");

      await expect(
        sendMSTeamsMessages({
          replyStyle: "thread",
          app: createMockApp(),
          appId: "app123",
          conversationRef: baseRef,
          context: { sendActivity },
          messages: [{ mediaUrl: missingPath }],
        }),
      ).rejects.toBeInstanceOf(PlatformMessageNotDispatchedError);
      expect(sendActivity).not.toHaveBeenCalled();
    });

    it("loads uppercase file URLs before sending personal images", async () => {
      const tmpDir = await mkdtemp(
        path.join(resolvePreferredOpenClawTmpDir(), "msteams-file-url-"),
      );
      const localFile = path.join(tmpDir, "café image.png");
      const png = Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=",
        "base64",
      );
      await writeFile(localFile, png);

      try {
        const mediaUrl = pathToFileURL(localFile).href.replace(/^file:/u, "FILE:");
        const activity = await buildActivity(
          { mediaUrl },
          {
            ...baseRef,
            conversation: { ...baseRef.conversation, conversationType: "personal" },
          },
        );
        const attachment = (activity.attachments as Array<Record<string, unknown>>)[0];

        expect(attachment).toMatchObject({
          name: "café image.png",
          contentType: "image/png",
          contentUrl: `data:image/png;base64,${png.toString("base64")}`,
        });
      } finally {
        await rm(tmpDir, { recursive: true, force: true });
      }
    });

    it("does not claim no dispatch after an earlier batch message was sent", async () => {
      const sendActivity = vi.fn(async () => ({ id: "sent-first" }));
      const missingPath = path.join(resolvePreferredOpenClawTmpDir(), "missing-second-file.txt");

      const error = await sendMSTeamsMessages({
        replyStyle: "thread",
        app: createMockApp(),
        appId: "app123",
        conversationRef: baseRef,
        context: { sendActivity },
        messages: [{ text: "first" }, { mediaUrl: missingPath }],
      }).catch((cause: unknown) => cause);

      expect(sendActivity).toHaveBeenCalledTimes(1);
      expect(error).toBeInstanceOf(Error);
      expect(error).not.toBeInstanceOf(PlatformMessageNotDispatchedError);
    });

    it("does not claim no dispatch when proactive fallback preparation fails after a send", async () => {
      const threadSent: string[] = [];
      const error = await sendMSTeamsMessages({
        replyStyle: "thread",
        app: createMockApp(),
        appId: "app123",
        conversationRef: {
          ...baseRef,
          user: undefined,
        },
        context: createRevokedThreadContext({ failAfterAttempt: 2, sent: threadSent }),
        messages: [{ text: "first" }, { text: "second" }],
      }).catch((cause: unknown) => cause);

      expect(threadSent).toEqual(["first"]);
      expect(error).toBeInstanceOf(Error);
      expect(error).not.toBeInstanceOf(PlatformMessageNotDispatchedError);
      expect((error as Error).message).toContain("missing user.id");
    });

    it("marks invalid proactive conversation references as never dispatched", async () => {
      await expect(
        sendMSTeamsMessages({
          replyStyle: "top-level",
          app: createMockApp(),
          appId: "app123",
          conversationRef: {
            ...baseRef,
            conversation: { id: "" },
          },
          messages: [{ text: "hello" }],
        }),
      ).rejects.toBeInstanceOf(PlatformMessageNotDispatchedError);
    });

    it("retries thread sends after a replay-safe HTTP 429", async () => {
      const attempts: string[] = [];
      const retryEvents: Array<{ nextAttempt: number; delayMs: number }> = [];

      const ctx = {
        sendActivity: createRecordedSendActivity(attempts, 429),
      };
      const ids = await sendMSTeamsMessages({
        replyStyle: "thread",
        app: createMockApp(),
        appId: "app123",
        conversationRef: baseRef,
        context: ctx,
        messages: [{ text: "one" }],
        retry: { maxAttempts: 2, baseDelayMs: 0, maxDelayMs: 0 },
        onRetry: (e) => retryEvents.push({ nextAttempt: e.nextAttempt, delayMs: e.delayMs }),
      });

      expect(attempts).toEqual(["one", "one"]);
      expect(ids).toEqual(["id:one"]);
      expect(retryEvents).toEqual([{ nextAttempt: 2, delayMs: 0 }]);
