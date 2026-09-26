import { describe, expect, test } from "bun:test";

import {
  installInvocationFetchProxy,
  uninstallInvocationFetchProxyForTests,
  withInvocationProxyEnv,
} from "./invocation_env";

type FetchCall = {
  input: Parameters<typeof fetch>[0];
  init: Parameters<typeof fetch>[1];
};

async function withStubbedFetch<T>(
  testBody: (calls: FetchCall[]) => Promise<T>,
): Promise<T> {
  uninstallInvocationFetchProxyForTests();
  const originalFetch = globalThis.fetch;
  const calls: FetchCall[] = [];
  globalThis.fetch = (async (input, init) => {
    calls.push({ input, init });
    return new Response("ok");
  }) as typeof fetch;

  try {
    installInvocationFetchProxy();
    return await testBody(calls);
  } finally {
    uninstallInvocationFetchProxyForTests();
    globalThis.fetch = originalFetch;
  }
}

function proxyFrom(call: FetchCall): unknown {
  return (call.init as (RequestInit & { proxy?: unknown }) | undefined)?.proxy;
}

function callAt(calls: FetchCall[], index: number): FetchCall {
  const call = calls[index];
  expect(call).toBeDefined();
  return call!;
}

describe("withInvocationProxyEnv", () => {
  test("injects the per-action proxy into HTTPS fetch calls", async () => {
    await withStubbedFetch(async (calls) => {
      await withInvocationProxyEnv(
        {
          HTTPS_PROXY: "http://hatch-runtime:https-token@hatch-egress-proxy:3128",
        },
        async () => {
          await fetch("https://hacker-news.firebaseio.com/v0/topstories.json");
        },
      );

      expect(calls).toHaveLength(1);
      expect(proxyFrom(callAt(calls, 0))).toBe(
        "http://hatch-runtime:https-token@hatch-egress-proxy:3128",
      );
    });
  });

  test("keeps concurrent invocation proxy tokens separate", async () => {
    await withStubbedFetch(async (calls) => {
      let releaseFirst: () => void = () => {};
      const firstCanFinish = new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });

      const first = withInvocationProxyEnv(
        {
          HTTPS_PROXY: "http://hatch-runtime:first-token@hatch-egress-proxy:3128",
        },
        async () => {
          await fetch("https://example.com/first");
          await firstCanFinish;
          await fetch("https://example.com/first-done");
        },
      );
      const second = withInvocationProxyEnv(
        {
          HTTPS_PROXY: "http://hatch-runtime:second-token@hatch-egress-proxy:3128",
        },
        async () => {
          await fetch("https://example.com/second");
        },
      );

      await Bun.sleep(1);
      releaseFirst();
      await Promise.all([first, second]);

      expect(calls.map(proxyFrom)).toEqual([
        "http://hatch-runtime:first-token@hatch-egress-proxy:3128",
        "http://hatch-runtime:second-token@hatch-egress-proxy:3128",
        "http://hatch-runtime:first-token@hatch-egress-proxy:3128",
      ]);
    });
  });

  test("does not proxy unix, explicit-proxy, or non-HTTP fetches", async () => {
    await withStubbedFetch(async (calls) => {
      await withInvocationProxyEnv(
        {
          HTTPS_PROXY: "http://hatch-runtime:https-token@hatch-egress-proxy:3128",
        },
        async () => {
          await fetch("https://example.com/unix", {
            unix: "/run/hatch/daemon/http-api.sock",
          } as RequestInit & { unix: string });
          await fetch("https://example.com/explicit", {
            proxy: "http://explicit-proxy:3128",
          } as RequestInit & { proxy: string });
          await fetch("file:///tmp/example.txt");
        },
      );

      expect(calls.map(proxyFrom)).toEqual([
        undefined,
        "http://explicit-proxy:3128",
        undefined,
      ]);
    });
  });
});
