import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import { build } from "esbuild";
import { expect, it } from "vitest";

type BrowserHostModule = {
  configureAiTransportHost(host: object): void;
  createApiRegistry(): {
    registerApiProvider(provider: object): void;
  };
  createLlmRuntime(registry: object): {
    stream(model: object, context: object): { result(): Promise<unknown> };
  };
  getDefaultAiTransportHost(): unknown;
  runWithAiTransportHost<T>(host: unknown, run: () => T): T;
};

it("keeps the default transport host usable in browser bundles", async () => {
  const result = await build({
    entryPoints: [fileURLToPath(new URL("./index.ts", import.meta.url))],
    bundle: true,
    format: "iife",
    globalName: "OpenClawAiHost",
    logLevel: "silent",
    platform: "browser",
    write: false,
  });

  expect(result.errors).toEqual([]);
  const context: {
    OpenClawAiHost?: BrowserHostModule;
    TextDecoder: typeof TextDecoder;
    TextEncoder: typeof TextEncoder;
  } = {
    TextDecoder,
    TextEncoder,
  };
  runInNewContext(result.outputFiles[0]?.text ?? "", context);
  const browserHost = context.OpenClawAiHost;
  if (!browserHost) {
    throw new Error("browser bundle did not expose its host contract");
  }
  expect(
    browserHost.runWithAiTransportHost(browserHost.getDefaultAiTransportHost(), () => "ok"),
  ).toBe("ok");

  const final = { role: "assistant", content: [], stopReason: "stop" };
  const source = {
    push() {},
    end() {},
    async result() {
      return final;
    },
    async *[Symbol.asyncIterator]() {},
  };
  const registry = browserHost.createApiRegistry();
  registry.registerApiProvider({
    api: "browser-test",
    // The provider belongs to this test realm, not the browser VM realm.
    stream: async () => source,
    streamSimple: () => source,
  });
  const runtime = browserHost.createLlmRuntime(registry);
  const stream = runtime.stream(
    { api: "browser-test", provider: "fixture", id: "browser" },
    { messages: [] },
  );
  browserHost.configureAiTransportHost({});
  await expect(stream.result()).resolves.toBe(final);
});
