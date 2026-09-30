import type {
  AssistantMessage,
  AssistantMessageEventStreamContract,
  Model,
} from "@openclaw/llm-core";
import {
  createAssistantMessageEventStream,
  getEventStreamCompletion,
} from "@openclaw/llm-core/event-stream";
import { afterEach, describe, expect, it } from "vitest";
import { createApiRegistry } from "./api-registry.js";
import {
  configureAiTransportHost,
  createAiTransportHost,
  getAiTransportHost,
  getDefaultAiTransportHost,
  runWithAiTransportHost,
} from "./host.js";
import { createLlmRuntime, createNodeLlmRuntime } from "./stream.js";

const original = getDefaultAiTransportHost();
afterEach(() => configureAiTransportHost(original));
const model: Model = {
  id: "scoped",
  name: "Scoped",
  provider: "fixture",
  api: "test-scoped",
  baseUrl: "https://fixture.invalid",
  reasoning: false,
  input: ["text"],
  contextWindow: 1000,
  maxTokens: 100,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};
function message(text: string): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    provider: model.provider,
    model: model.id,
    api: model.api,
    stopReason: "stop",
    timestamp: 1,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  };
}
function registryFor(resolve: (value: string) => Promise<string>) {
  const registry = createApiRegistry();
  const stream = (
    _model: Model,
    _context: unknown,
    options?: { apiKey?: string },
  ): AssistantMessageEventStreamContract => {
    const result = async () => message(await resolve(options?.apiKey ?? ""));
    return {
      push() {},
      end() {},
      result,
      async *[Symbol.asyncIterator]() {
        const final = await result();
        yield { type: "done", reason: "stop", message: final };
      },
    };
  };
  registry.registerApiProvider({ api: model.api, stream, streamSimple: stream });
  return registry;
}
function deferred() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

describe("runtime-owned transport host", () => {
  it.each([false, true])("accepts frozen provider streams (scoped=%s)", async (scoped) => {
    const observations: string[] = [];
    const observe = (operation: string) =>
      observations.push(getAiTransportHost().resolveSecretSentinel(operation));
    const final = message("immutable producer");
    const source: AssistantMessageEventStreamContract = Object.freeze({
      push() {
        expect(this).toBe(source);
        observe("push");
      },
      end() {
        expect(this).toBe(source);
        observe("end");
      },
      async result() {
        expect(this).toBe(source);
        observe("result");
        return final;
      },
      [Symbol.asyncIterator]() {
        expect(this).toBe(source);
        observe("iterator");
        return {
          async next() {
            observe("next");
            return {
              done: false as const,
              value: { type: "done" as const, reason: "stop" as const, message: final },
            };
          },
          async return() {
            observe("return");
            return { done: true as const, value: undefined };
          },
          async throw(error: unknown) {
            observe("throw");
            throw error;
          },
        };
      },
    });
    const registry = createApiRegistry();
    registry.registerApiProvider({
      api: model.api,
      stream: () => source,
      streamSimple: () => source,
    });
    configureAiTransportHost({ resolveSecretSentinel: (value) => "gateway:" + value });
    const runtime = scoped
      ? createNodeLlmRuntime(registry, {
          resolveSecretSentinel: (value) => "scoped:" + value,
        })
      : createLlmRuntime(registry);
    for (const method of ["stream", "streamSimple"] as const) {
      const stream = runtime[method](model, { messages: [] });
      stream.push({ type: "done", reason: "stop", message: final });
      stream.end(final);
      expect(await stream.result()).toBe(final);
      const iterator = stream[Symbol.asyncIterator]();
      expect((await iterator.next()).value).toEqual({
        type: "done",
        reason: "stop",
        message: final,
      });
      const finish = iterator.return?.bind(iterator);
      const fail = iterator.throw?.bind(iterator);
      if (!finish || !fail) {
        throw new Error("fixture iterator must support early return and failure");
      }
      expect(await finish()).toEqual({ done: true, value: undefined });
      const error = new Error("iterator consumer stopped");
      await expect(fail(error)).rejects.toBe(error);
    }
    expect(await runtime.complete(model, { messages: [] })).toBe(final);
    expect(await runtime.completeSimple(model, { messages: [] })).toBe(final);
    expect(observations).toEqual(
      [
        "push",
        "end",
        "result",
        "iterator",
        "next",
        "return",
        "throw",
        "push",
        "end",
        "result",
        "iterator",
        "next",
        "return",
        "throw",
        "result",
        "result",
      ].map((value) => (scoped ? "scoped:" : "gateway:") + value),
    );
    expect(getAiTransportHost().resolveSecretSentinel("caller")).toBe("gateway:caller");
    expect(Object.isFrozen(source)).toBe(true);
  });

  it.each([
    ["stream", false],
    ["stream", true],
    ["streamSimple", false],
    ["streamSimple", true],
  ] as const)(
    "preserves native producer completion through %s (async factory=%s) without invoking result decorators",
    async (method, asyncFactory) => {
      const source = createAssistantMessageEventStream();
      const result = source.result.bind(source);
      let resultCalls = 0;
      const decoratedResult = () => {
        resultCalls += 1;
        return result();
      };
      source.result = decoratedResult;
      const registry = createApiRegistry();
      const start = asyncFactory ? async () => source : () => source;
      registry.registerApiProvider({
        api: model.api,
        stream: start,
        streamSimple: start,
      });
      Object.defineProperty(source, "result", { value: decoratedResult, writable: false });
      const runtime = createNodeLlmRuntime(registry);
      const scoped = runtime[method](model, { messages: [] });
      const completion = getEventStreamCompletion(scoped);
      if (asyncFactory) {
        expect(completion).toBeInstanceOf(Promise);
      } else {
        expect(completion).toBe(getEventStreamCompletion(source));
      }
      expect(resultCalls).toBe(0);
      const final = message("producer done");
      source.end(final);
      await expect(completion).resolves.toBe(final);
      expect(resultCalls).toBe(0);
      await expect(scoped.result()).resolves.toBe(final);
      expect(resultCalls).toBe(1);
    },
  );

  it("keeps overlapping native hosts separate while the ordinary runtime selects the current default", async () => {
    const gate = deferred();
    const registry = registryFor(async (value) => {
      await gate.promise;
      return getAiTransportHost().resolveSecretSentinel(value);
    });
    // Construct before installation: ordinary runtimes must not snapshot inert policy.
    const ordinary = createLlmRuntime(registry);
    const native = createNodeLlmRuntime(registry);
    const other = createNodeLlmRuntime(registry, {
      resolveSecretSentinel: (value) => "other:" + value,
    });
    configureAiTransportHost({
      resolveSecretSentinel: (value) => {
        if (value !== "known") {
          throw new Error("unknown Gateway credential");
        }
        return "Gateway-owned";
      },
    });
    const one = native.completeSimple(model, { messages: [] }, { apiKey: "opaque-one" });
    const two = other.completeSimple(model, { messages: [] }, { apiKey: "opaque-two" });
    const normal = ordinary.completeSimple(model, { messages: [] }, { apiKey: "known" });
    const refused = expect(
      ordinary.completeSimple(model, { messages: [] }, { apiKey: "unknown" }),
    ).rejects.toThrow("unknown Gateway");
    expect(() => getAiTransportHost().resolveSecretSentinel("unknown")).toThrow("unknown Gateway");
    gate.release();
    expect((await one).content).toEqual([{ type: "text", text: "opaque-one" }]);
    expect((await two).content).toEqual([{ type: "text", text: "other:opaque-two" }]);
    expect((await normal).content).toEqual([{ type: "text", text: "Gateway-owned" }]);
    await refused;
    expect(() => getAiTransportHost().resolveSecretSentinel("unknown")).toThrow("unknown Gateway");
  });

  it("does not let a nested ordinary runtime inherit native policy", async () => {
    configureAiTransportHost({ resolveSecretSentinel: (value) => "Gateway:" + value });
    const ordinary = createLlmRuntime(
      registryFor(async (value) => getAiTransportHost().resolveSecretSentinel(value)),
    );
    const native = createNodeLlmRuntime(
      registryFor(async (value) => {
        await Promise.resolve();
        expect(getAiTransportHost().resolveSecretSentinel(value)).toBe(value);
        const nested = await ordinary.complete(model, { messages: [] }, { apiKey: value });
        expect(nested.content).toEqual([{ type: "text", text: "Gateway:" + value }]);
        return getAiTransportHost().resolveSecretSentinel(value);
      }),
    );
    expect((await native.complete(model, { messages: [] }, { apiKey: "opaque" })).content).toEqual([
      { type: "text", text: "opaque" },
    ]);
  });

  it.each(["stream", "streamSimple"] as const)(
    "binds a host adapter that creates %s asynchronously",
    async (method) => {
      const registry = createApiRegistry();
      let resultCalls = 0;
      const createStream = async () => {
        await Promise.resolve();
        expect(getAiTransportHost().resolveSecretSentinel("start")).toBe("native:start");
        return {
          push() {},
          end() {},
          async result() {
            resultCalls += 1;
            await Promise.resolve();
            expect(getAiTransportHost().resolveSecretSentinel("result")).toBe("native:result");
            return message("async source");
          },
          async *[Symbol.asyncIterator]() {},
        };
      };
      registry.registerApiProvider({
        api: model.api,
        stream: createStream,
        streamSimple: createStream,
      });
      configureAiTransportHost({ resolveSecretSentinel: (value) => "Gateway:" + value });
      const runtime = createNodeLlmRuntime(registry, {
        resolveSecretSentinel: (value) => "native:" + value,
      });

      const scoped = runtime[method](model, { messages: [] });
      const completion = getEventStreamCompletion(scoped);
      expect(getAiTransportHost().resolveSecretSentinel("caller")).toBe("Gateway:caller");
      await expect(scoped.result()).resolves.toEqual(message("async source"));
      await expect(completion).resolves.toEqual(message("async source"));
      expect(resultCalls).toBe(1);
    },
  );

  it("settles both public result and producer completion when an async factory rejects", async () => {
    const failure = new Error("provider startup failed");
    const registry = createApiRegistry();
    const start = async () => {
      throw failure;
    };
    registry.registerApiProvider({ api: model.api, stream: start, streamSimple: start });
    const stream = createNodeLlmRuntime(registry).stream(model, { messages: [] });

    await expect(stream.result()).rejects.toBe(failure);
    await expect(getEventStreamCompletion(stream)).rejects.toBe(failure);
  });

  it.each(["push", "end"] as const)(
    "surfaces a deferred producer %s failure through every settlement channel",
    async (method) => {
      const failure = new Error(`${method} failed`);
      const registry = createApiRegistry();
      const start = async (): Promise<AssistantMessageEventStreamContract> => ({
        push() {
          if (method === "push") {
            throw failure;
          }
        },
        end() {
          if (method === "end") {
            throw failure;
          }
        },
        result: async () => message("premature success"),
        async *[Symbol.asyncIterator]() {},
      });
      registry.registerApiProvider({ api: model.api, stream: start, streamSimple: start });
      const stream = createNodeLlmRuntime(registry).stream(model, { messages: [] });
      if (method === "push") {
        stream.push({ type: "done", reason: "stop", message: message("unused") });
      } else {
        stream.end(message("unused"));
      }

      await Promise.all([
        expect(stream.result()).rejects.toBe(failure),
        expect(getEventStreamCompletion(stream)).rejects.toBe(failure),
        expect(stream[Symbol.asyncIterator]().next()).rejects.toBe(failure),
      ]);
    },
  );

  it.each(["push", "end"] as const)(
    "settles every channel when a deferred producer %s fails after startup",
    async (method) => {
      const failure = new Error(`${method} failed after startup`);
      const registry = createApiRegistry();
      const start = async (): Promise<AssistantMessageEventStreamContract> => ({
        push() {
          if (method === "push") {
            throw failure;
          }
        },
        end() {
          if (method === "end") {
            throw failure;
          }
        },
        result: () => new Promise<AssistantMessage>(() => {}),
        async *[Symbol.asyncIterator]() {},
      });
      registry.registerApiProvider({ api: model.api, stream: start, streamSimple: start });
      const stream = createNodeLlmRuntime(registry).stream(model, { messages: [] });
      await expect(stream[Symbol.asyncIterator]().next()).resolves.toEqual({
        done: true,
        value: undefined,
      });

      expect(() => {
        if (method === "push") {
          stream.push({ type: "done", reason: "stop", message: message("unused") });
        } else {
          stream.end(message("unused"));
        }
      }).toThrow(failure);
      await Promise.all([
        expect(stream.result()).rejects.toBe(failure),
        expect(getEventStreamCompletion(stream)).rejects.toBe(failure),
        expect(stream[Symbol.asyncIterator]().next()).rejects.toBe(failure),
      ]);
    },
  );

  it("keeps process installers independent of an active scoped host", async () => {
    configureAiTransportHost({ resolveSecretSentinel: (value) => "Gateway:" + value });
    await runWithAiTransportHost(createAiTransportHost(), async () => {
      await Promise.resolve();
      configureAiTransportHost({ ...getDefaultAiTransportHost(), logInfo: () => {} });
      expect(getAiTransportHost().resolveSecretSentinel("opaque")).toBe("opaque");
    });
    expect(getAiTransportHost().resolveSecretSentinel("opaque")).toBe("Gateway:opaque");
  });

  it.each(["stream", "streamSimple"] as const)(
    "binds lazy %s iteration and early return without leaking the caller context",
    async (method) => {
      const observations: string[] = [];
      const registry = createApiRegistry();
      const stream = (): AssistantMessageEventStreamContract => ({
        push() {},
        end() {},
        result: async () => message("done"),
        async *[Symbol.asyncIterator]() {
          try {
            await Promise.resolve();
            observations.push(getAiTransportHost().resolveSecretSentinel("iterate"));
            yield { type: "start", partial: message("start") };
          } finally {
            await Promise.resolve();
            observations.push(getAiTransportHost().resolveSecretSentinel("return"));
          }
        },
      });
      registry.registerApiProvider({ api: model.api, stream, streamSimple: stream });
      configureAiTransportHost({ resolveSecretSentinel: (value) => "Gateway:" + value });
      const native = createNodeLlmRuntime(registry);
      const scoped = native[method](model, { messages: [] });
      const iterator = scoped[Symbol.asyncIterator]();
      const iterateSelf = Reflect.get(iterator, Symbol.asyncIterator);
      if (typeof iterateSelf !== "function") {
        throw new Error("bound provider iterator must remain async iterable");
      }
      expect(Reflect.apply(iterateSelf, iterator, [])).toBe(iterator);
      for await (const event of scoped) {
        expect(event.type).toBe("start");
        expect(getAiTransportHost().resolveSecretSentinel("caller")).toBe("Gateway:caller");
        break;
      }
      expect(observations).toEqual(["iterate", "return"]);
    },
  );
});
