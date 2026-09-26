import { AsyncLocalStorage } from "node:async_hooks";

export type InvocationProxyEnv = Record<string, string> | undefined;

type FetchImpl = typeof globalThis.fetch;
type FetchArgs = Parameters<FetchImpl>;
type FetchInput = FetchArgs[0];
type FetchInit = FetchArgs[1];
type BunProxyFetchInit = NonNullable<FetchInit> & {
  proxy?: unknown;
  unix?: unknown;
};

interface InvocationEnvContext {
  proxyEnv: InvocationProxyEnv;
}

const invocationEnv = new AsyncLocalStorage<InvocationEnvContext>();
const WRAPPED_FETCH = Symbol.for("hatch.spaceWorker.invocationFetchProxy");
const ORIGINAL_FETCH = Symbol.for("hatch.spaceWorker.originalFetch");

type WrappedFetch = FetchImpl & {
  [WRAPPED_FETCH]?: true;
  [ORIGINAL_FETCH]?: FetchImpl;
};

export async function withInvocationProxyEnv<T>(
  proxyEnv: InvocationProxyEnv,
  invoke: () => Promise<T>,
): Promise<T> {
  return await invocationEnv.run({ proxyEnv }, invoke);
}

export function installInvocationFetchProxy(): void {
  const currentFetch = globalThis.fetch as WrappedFetch;
  if (currentFetch[WRAPPED_FETCH]) {
    return;
  }

  const originalFetch = globalThis.fetch.bind(globalThis) as FetchImpl;
  const wrappedFetch = (async (...args: FetchArgs) => {
    const [input, init] = args;
    return await originalFetch(input, withInvocationProxy(input, init));
  }) as WrappedFetch;
  wrappedFetch[WRAPPED_FETCH] = true;
  wrappedFetch[ORIGINAL_FETCH] = originalFetch;
  globalThis.fetch = wrappedFetch;
}

export function uninstallInvocationFetchProxyForTests(): void {
  const currentFetch = globalThis.fetch as WrappedFetch;
  if (currentFetch[WRAPPED_FETCH] && currentFetch[ORIGINAL_FETCH]) {
    globalThis.fetch = currentFetch[ORIGINAL_FETCH];
  }
}

function withInvocationProxy(input: FetchInput, init: FetchInit): FetchInit {
  const proxyEnv = invocationEnv.getStore()?.proxyEnv;
  if (!proxyEnv) {
    return init;
  }

  const fetchInit = init as BunProxyFetchInit | undefined;
  if (
    fetchInit &&
    (hasConcreteFetchOverride(fetchInit.proxy) ||
      hasConcreteFetchOverride(fetchInit.unix))
  ) {
    return init;
  }

  const protocol = fetchInputProtocol(input);
  const proxy = proxyForProtocol(proxyEnv, protocol);
  if (!proxy) {
    return init;
  }

  return { ...(init ?? {}), proxy } as FetchInit;
}

function hasConcreteFetchOverride(value: unknown): boolean {
  if (value === undefined || value === null) {
    return false;
  }
  if (typeof value === "string") {
    return value.trim().length > 0;
  }
  return true;
}

function fetchInputProtocol(input: FetchInput): string | undefined {
  const url = fetchInputUrl(input);
  if (!url) {
    return undefined;
  }
  try {
    return new URL(url).protocol;
  } catch {
    return undefined;
  }
}

function fetchInputUrl(input: FetchInput): string | undefined {
  if (typeof input === "string") {
    return input;
  }
  if (input instanceof URL) {
    return input.href;
  }
  if (typeof Request !== "undefined" && input instanceof Request) {
    return input.url;
  }
  return undefined;
}

function proxyForProtocol(
  proxyEnv: Record<string, string>,
  protocol: string | undefined,
): string | undefined {
  if (protocol === "http:") {
    return firstProxyEnv(proxyEnv, ["HTTP_PROXY", "http_proxy", "ALL_PROXY", "all_proxy"]);
  }
  if (protocol === "https:") {
    return firstProxyEnv(proxyEnv, [
      "HTTPS_PROXY",
      "https_proxy",
      "ALL_PROXY",
      "all_proxy",
      "HTTP_PROXY",
      "http_proxy",
    ]);
  }
  return undefined;
}

function firstProxyEnv(
  proxyEnv: Record<string, string>,
  keys: readonly string[],
): string | undefined {
  for (const key of keys) {
    const value = proxyEnv[key]?.trim();
    if (value) {
      return value;
    }
  }
  return undefined;
}
