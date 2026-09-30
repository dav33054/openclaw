import type {
  Api,
  AssistantMessageEventStreamContract,
  Context,
  Model,
  SimpleStreamOptions,
  StreamOptions,
} from "@openclaw/llm-core";
import { bindDeferredAssistantMessageEventStream } from "@openclaw/llm-core/event-stream";

type ApiProviderStreamFunction<
  TApi extends Api = Api,
  TOptions extends StreamOptions = StreamOptions,
> = (
  model: Model<TApi>,
  context: Context,
  options?: TOptions,
) => AssistantMessageEventStreamContract | Promise<AssistantMessageEventStreamContract>;

/** Runtime stream adapter signature stored in the API provider registry. */
export type ApiStreamFunction = (
  model: Model,
  context: Context,
  options?: StreamOptions,
) => AssistantMessageEventStreamContract;

/** Runtime simple-stream adapter signature stored in the API provider registry. */
export type ApiStreamSimpleFunction = (
  model: Model,
  context: Context,
  options?: SimpleStreamOptions,
) => AssistantMessageEventStreamContract;

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    "then" in value &&
    typeof value.then === "function"
  );
}

/** Provider implementation registered by core or plugins for a specific model API. */
export interface ApiProvider<
  TApi extends Api = Api,
  TOptions extends StreamOptions = StreamOptions,
> {
  /** Model API id this provider handles. */
  api: TApi;
  /** Full streaming adapter for callers that already own structured options. */
  stream: ApiProviderStreamFunction<TApi, TOptions>;
  /** Simple streaming adapter used by agent and plugin runtime defaults. */
  streamSimple: ApiProviderStreamFunction<TApi, SimpleStreamOptions>;
}

/** Type-erased provider returned by a registry after API guards are installed. */
export interface RegisteredApiProvider {
  api: Api;
  stream: ApiStreamFunction;
  streamSimple: ApiStreamSimpleFunction;
}

type RegisteredApiProviderEntry = {
  provider: RegisteredApiProvider;
  sourceId?: string;
};

function wrapStream<TApi extends Api, TOptions extends StreamOptions>(
  api: TApi,
  stream: ApiProviderStreamFunction<TApi, TOptions>,
): ApiStreamFunction {
  return (model, context, options) => {
    if (model.api !== api) {
      throw new Error(`Mismatched api: ${model.api} expected ${api}`);
    }
    const started = stream(model as Model<TApi>, context, options as TOptions);
    if (isPromiseLike(started)) {
      return bindDeferredAssistantMessageEventStream(Promise.resolve(started), (operation) =>
        operation(),
      );
    }
    return started;
  };
}

/** Creates an isolated provider registry for one runtime or tenant. */
export function createApiRegistry() {
  const providers = new Map<string, RegisteredApiProviderEntry>();

  function registerApiProvider<TApi extends Api, TOptions extends StreamOptions>(
    provider: ApiProvider<TApi, TOptions>,
    /** Optional source id used to unregister all providers owned by one plugin/runtime. */
    sourceId?: string,
  ): void {
    providers.set(provider.api, {
      provider: {
        api: provider.api,
        stream: wrapStream(provider.api, provider.stream),
        streamSimple: wrapStream(provider.api, provider.streamSimple),
      },
      sourceId,
    });
  }

  function getApiProvider(api: Api): RegisteredApiProvider | undefined {
    return providers.get(api)?.provider;
  }

  function getApiProviders(): RegisteredApiProvider[] {
    return Array.from(providers.values(), (entry) => entry.provider);
  }

  function unregisterApiProviders(sourceId: string): void {
    for (const [api, entry] of providers.entries()) {
      if (entry.sourceId === sourceId) {
        providers.delete(api);
      }
    }
  }

  return {
    registerApiProvider,
    getApiProvider,
    getApiProviders,
    unregisterApiProviders,
    clearApiProviders: () => providers.clear(),
  };
}

export type ApiRegistry = ReturnType<typeof createApiRegistry>;
