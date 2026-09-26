import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Route } from "playwright";
import { describe, expect, test } from "bun:test";
import { connect as netConnect, createServer as netCreateServer } from "node:net";

import {
  attachAuditNetworkPolicy,
  capAriaSnapshot,
  confirmTransientUnreachable,
  dedupeBrokenAssets,
  formatConsoleWarning,
  isAuditRequestAllowed,
  isHighPriorityWarning,
  newExternalRequestLog,
  recordExternalRequest,
  startProxyAuthRelay,
} from "./playwright-audit";

const DAEMON_ORIGIN = "http://[fd8b:4f84:7d32:99::2]:18792";
const SLUG = "focus-board";
const ROUTE_SLUG = "hatch-audit-6b7c1978-4b1f-4b6f-952d-0cc2d2795cf2";

describe("startProxyAuthRelay", () => {
  test("injects Proxy-Authorization on every forwarded CONNECT", async () => {
    // Mock upstream Sentinel proxy: capture the CONNECT head, accept the tunnel.
    // This is the load-bearing attribution contract — the render's subresource
    // CONNECTs (Google Fonts) must carry the egress token so Sentinel attributes
    // them to the Space subject instead of runtime.unknown.
    let capturedHead = "";
    const upstream = netCreateServer((sock) => {
      sock.once("data", (chunk: Buffer) => {
        capturedHead = chunk.toString("latin1");
        sock.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      });
    });
    await new Promise<void>((resolve) => upstream.listen(0, "::1", resolve));
    const upstreamPort = (upstream.address() as { port: number }).port;

    const relay = await startProxyAuthRelay(
      `http://[::1]:${upstreamPort}`,
      "hatch-runtime",
      "tok-abc123",
    );
    try {
      const relayPort = Number(new URL(relay.server).port);
      const status = await new Promise<string>((resolve, reject) => {
        const c = netConnect(relayPort, "::1", () => {
          c.write(
            "CONNECT example.com:443 HTTP/1.1\r\nHost: example.com:443\r\n\r\n",
          );
        });
        c.once("data", (chunk: Buffer) => {
          resolve(chunk.toString("latin1"));
          c.end();
        });
        c.once("error", reject);
      });
      const expectedCredential =
        "Proxy-Authorization: Basic " +
        Buffer.from("hatch-runtime:tok-abc123").toString("base64");
      expect(status).toContain("200");
      expect(capturedHead).toContain("CONNECT example.com:443");
      expect(capturedHead).toContain(expectedCredential);
    } finally {
      await relay.close();
      await new Promise<void>((resolve) => upstream.close(() => resolve()));
    }
  });

  test("forwards a non-200 upstream CONNECT verbatim and does not tunnel", async () => {
    // The "denied stays denied" contract: the relay must surface a policy
    // denial (e.g. 403) to Chromium unchanged and never establish a tunnel on a
    // non-200. Injecting the token sets attribution only; it never overrides
    // Sentinel's decision.
    const upstream = netCreateServer((sock) => {
      sock.once("data", () => {
        sock.write("HTTP/1.1 403 Forbidden\r\n\r\n");
        sock.end();
      });
    });
    await new Promise<void>((resolve) => upstream.listen(0, "::1", resolve));
    const upstreamPort = (upstream.address() as { port: number }).port;

    const relay = await startProxyAuthRelay(
      `http://[::1]:${upstreamPort}`,
      "hatch-runtime",
      "tok-xyz789",
    );
    try {
      const relayPort = Number(new URL(relay.server).port);
      const response = await new Promise<string>((resolve, reject) => {
        let data = "";
        const c = netConnect(relayPort, "::1", () => {
          c.write(
            "CONNECT denied.example:443 HTTP/1.1\r\nHost: denied.example:443\r\n\r\n",
          );
        });
        c.on("data", (chunk: Buffer) => {
          data += chunk.toString("latin1");
        });
        c.on("close", () => resolve(data));
        c.once("error", reject);
      });
      expect(response).toContain("403");
      expect(response).not.toContain("200");
    } finally {
      await relay.close();
      await new Promise<void>((resolve) => upstream.close(() => resolve()));
    }
  });
});

describe("isAuditRequestAllowed", () => {
  test("admits only the opaque route alias for same-origin Space paths", () => {
    expect(
      isAuditRequestAllowed(
        `${DAEMON_ORIGIN}/spaces/v2/${ROUTE_SLUG}/`,
        DAEMON_ORIGIN,
        ROUTE_SLUG,
      ),
    ).toBe(true);
    expect(
      isAuditRequestAllowed(
        `${DAEMON_ORIGIN}/spaces/v2/${SLUG}/`,
        DAEMON_ORIGIN,
        ROUTE_SLUG,
      ),
    ).toBe(false);
  });

  test("allows arbitrary external CDNs and font hosts", () => {
    expect(
      isAuditRequestAllowed(
        "https://cdn.example.com/lib.js",
        DAEMON_ORIGIN,
        ROUTE_SLUG,
      ),
    ).toBe(true);
    expect(
      isAuditRequestAllowed(
        "https://fonts.googleapis.com/css2?family=Inter",
        DAEMON_ORIGIN,
        ROUTE_SLUG,
      ),
    ).toBe(true);
    expect(
      isAuditRequestAllowed(
        "https://images.unsplash.com/photo-123.jpg",
        DAEMON_ORIGIN,
        ROUTE_SLUG,
      ),
    ).toBe(true);
  });

  test("blocks same-origin requests to the daemon's /api/* surface", () => {
    expect(
      isAuditRequestAllowed(
        `${DAEMON_ORIGIN}/api/config`,
        DAEMON_ORIGIN,
        ROUTE_SLUG,
      ),
    ).toBe(false);
    expect(
      isAuditRequestAllowed(
        `${DAEMON_ORIGIN}/api/runtime/status`,
        DAEMON_ORIGIN,
        ROUTE_SLUG,
      ),
    ).toBe(false);
  });

  test("blocks slug-prefix collisions", () => {
    // A prefix collision must not escape the one opaque alias scope.
    expect(
      isAuditRequestAllowed(
        `${DAEMON_ORIGIN}/spaces/v2/${ROUTE_SLUG}-evil/`,
        DAEMON_ORIGIN,
        ROUTE_SLUG,
      ),
    ).toBe(false);
  });

  test("blocks unparseable URLs rather than admitting them", () => {
    expect(
      isAuditRequestAllowed("not a url", DAEMON_ORIGIN, ROUTE_SLUG),
    ).toBe(false);
  });
});

describe("attachAuditNetworkPolicy", () => {
  test("scopes audit credentials to the opaque route alias", async () => {
    type RouteHandler = (route: {
      request(): {
        url(): string;
        method(): string;
        resourceType(): string;
        postData(): string | null;
        headers(): Record<string, string>;
      };
      abort(reason: string): Promise<void>;
      continue(overrides?: {
        headers?: Record<string, string>;
        url?: string;
      }): Promise<void>;
      fetch(overrides?: {
        headers?: Record<string, string>;
        maxRedirects?: number;
        timeout?: number;
        url?: string;
      }): Promise<{ marker: string }>;
      fulfill(overrides: { response: { marker: string } }): Promise<void>;
    }) => Promise<void>;

    let handler: RouteHandler | undefined;
    // Interception is installed on the browser CONTEXT (so popups are covered),
    // so the mock page hands one back.
    const context = {
      route(_pattern: string, routeHandler: RouteHandler) {
        handler = routeHandler;
        return Promise.resolve();
      },
      on() {},
    };
    const page = {
      context: () => context,
      on() {},
    };
    const blockedRequests: string[] = [];
    const externalRequests = newExternalRequestLog();
    await attachAuditNetworkPolicy(
      page as never,
      `${DAEMON_ORIGIN}/spaces/v2/${ROUTE_SLUG}/`,
      SLUG,
      ROUTE_SLUG,
      "endorsement.audit-token",
      "audit-session-id",
      blockedRequests,
      externalRequests,
    );
    expect(handler).toBeDefined();

    const dispatch = async (url: string) => {
      const aborts: string[] = [];
      const continues: Array<
        { headers?: Record<string, string>; url?: string } | undefined
      > = [];
      const fetches: Array<{
        headers?: Record<string, string>;
        maxRedirects?: number;
        timeout?: number;
        url?: string;
      }> = [];
      const fulfills: Array<{ response: { marker: string } }> = [];
      await handler!({
        request: () => ({
          url: () => url,
          method: () => "GET",
          resourceType: () => "fetch",
          postData: () => null,
          headers: () => ({ "x-existing": "preserved" }),
        }),
        abort: async (reason) => {
          aborts.push(reason);
        },
        continue: async (overrides) => {
          continues.push(overrides);
        },
        fetch: async (overrides = {}) => {
          fetches.push(overrides);
          return { marker: "one-hop-response" };
        },
        fulfill: async (overrides) => {
          fulfills.push(overrides);
        },
      });
      return { aborts, continues, fetches, fulfills };
    };

    const aliasRequest = await dispatch(
      `${DAEMON_ORIGIN}/spaces/v2/${ROUTE_SLUG}/assets/app.js`,
    );
    expect(aliasRequest.aborts).toEqual([]);
    expect(aliasRequest.continues).toEqual([]);
    expect(aliasRequest.fetches).toEqual([
      {
        headers: {
          "x-existing": "preserved",
          authorization: "endorsement.audit-token",
          "x-hatch-audit-session": "audit-session-id",
        },
        maxRedirects: 0,
        timeout: 0,
      },
    ]);
    expect(aliasRequest.fulfills).toEqual([
      { response: { marker: "one-hop-response" } },
    ]);

    const canonicalRequest = await dispatch(
      `${DAEMON_ORIGIN}/spaces/v2/${SLUG}/assets/app.js`,
    );
    expect(canonicalRequest.aborts).toEqual(["blockedbyclient"]);
    expect(canonicalRequest.continues).toEqual([]);

    const privilegedRequest = await dispatch(`${DAEMON_ORIGIN}/api/config`);
    expect(privilegedRequest.aborts).toEqual(["blockedbyclient"]);
    expect(privilegedRequest.continues).toEqual([]);
    expect(blockedRequests).toEqual([
      `${DAEMON_ORIGIN}/spaces/v2/${SLUG}/assets/app.js`,
      `${DAEMON_ORIGIN}/api/config`,
    ]);

    const legacyBlobRequest = await dispatch(
      `${DAEMON_ORIGIN}/spaces/v2/${SLUG}/blobs/image-key`,
    );
    expect(legacyBlobRequest.aborts).toEqual([]);
    expect(legacyBlobRequest.fetches[0]?.maxRedirects).toBe(0);
    expect(legacyBlobRequest.fetches[0]?.url).toBe(
      `${DAEMON_ORIGIN}/spaces/v2/${ROUTE_SLUG}/spaces/v2/${SLUG}/blobs/image-key`,
    );

    const crossOriginRequest = await dispatch("https://cdn.example.com/app.js");
    expect(crossOriginRequest.aborts).toEqual([]);
    expect(crossOriginRequest.continues).toEqual([undefined]);
    // The cross-origin attempt is recorded for the exfiltration screen —
    // custom headers kept, and never any same-origin (daemon) request.
    expect(externalRequests.requests).toEqual([
      {
        url: "https://cdn.example.com/app.js",
        method: "GET",
        resource_type: "fetch",
        headers: { "x-existing": "preserved" },
      },
    ]);
  });

  test("aborts (never throws) when route.fetch fails mid-flight", async () => {
    // A daemon/edge bounce can drop the connection during the one-hop re-issue,
    // rejecting route.fetch. The async route handler must NOT let that reject
    // escape — an unhandled rejection crashes the whole audit process. It must
    // abort the route instead, so the failure surfaces to the browser normally.
    type Route = {
      request(): { url(): string; headers(): Record<string, string> };
      abort(reason: string): Promise<void>;
      continue(overrides?: unknown): Promise<void>;
      fetch(overrides?: unknown): Promise<{ marker: string }>;
      fulfill(overrides: unknown): Promise<void>;
    };
    let handler: ((route: Route) => Promise<void>) | undefined;
    const context = {
      route(_pattern: string, routeHandler: (route: Route) => Promise<void>) {
        handler = routeHandler;
        return Promise.resolve();
      },
      on() {},
    };
    const page = {
      context: () => context,
      on() {},
    };
    await attachAuditNetworkPolicy(
      page as never,
      `${DAEMON_ORIGIN}/spaces/v2/${ROUTE_SLUG}/`,
      SLUG,
      ROUTE_SLUG,
      "endorsement.audit-token",
      "audit-session-id",
      [],
      newExternalRequestLog(),
    );
    expect(handler).toBeDefined();

    const aborts: string[] = [];
    const fulfills: unknown[] = [];
    // If the handler didn't catch the fetch rejection, this await would throw
    // and fail the test — which is exactly the audit-crashing behavior.
    await handler!({
      request: () => ({
        url: () => `${DAEMON_ORIGIN}/spaces/v2/${ROUTE_SLUG}/`,
        headers: () => ({}),
      }),
      abort: async (reason: string) => {
        aborts.push(reason);
      },
      continue: async () => {},
      fetch: async () => {
        throw new Error("The socket connection was closed unexpectedly");
      },
      fulfill: async (o: unknown) => {
        fulfills.push(o);
      },
    });
    expect(aborts).toEqual(["failed"]);
    expect(fulfills).toEqual([]);
  });
});

describe("recordExternalRequest", () => {
  // This log is the exfiltration screen's entire content-layer evidence, so
  // its cap/dedup/truncation policy decides what "screened clean" can mean.
  const external = (
    overrides: Partial<{
      url: string;
      method: string;
      resourceType: string;
      headers: Record<string, string>;
      postData: string | null;
    }> = {},
  ) => ({
    url: "https://exfil.example/collect",
    method: "GET",
    resourceType: "fetch",
    ...overrides,
  });

  test("flags truncation when a header is dropped past the per-request cap", () => {
    const log = newExternalRequestLog();
    const headers: Record<string, string> = {};
    for (let i = 0; i < 13; i += 1) headers[`x-custom-${i}`] = "v";
    recordExternalRequest(log, external({ headers }));
    const entry = log.requests[0]!;
    expect(Object.keys(entry.headers ?? {})).toHaveLength(12);
    expect(entry.truncated).toBe(true);
  });

  test("flags truncation when a header value is sliced", () => {
    const log = newExternalRequestLog();
    recordExternalRequest(
      log,
      external({ headers: { "x-payload": "s".repeat(300) } }),
    );
    const entry = log.requests[0]!;
    expect(entry.headers?.["x-payload"]).toHaveLength(256);
    expect(entry.truncated).toBe(true);
  });

  test("same url with different headers is recorded, not deduped away", () => {
    // A benign request must never be able to make a secret-bearing request to
    // the same URL vanish before the screen ever sees it.
    const log = newExternalRequestLog();
    recordExternalRequest(log, external({ headers: { "x-note": "benign" } }));
    recordExternalRequest(log, external({ headers: { "x-note": "sekrit" } }));
    recordExternalRequest(log, external({ headers: { "x-note": "benign" } }));
    expect(log.requests.map((r) => r.headers?.["x-note"])).toEqual([
      "benign",
      "sekrit",
    ]);
  });

  test("a GET flood cannot evict a data-bearing request", () => {
    // 40 benign GETs to a decoy host used to fill the cap, so the sendBeacon
    // that followed was dropped silently and never screened.
    const log = newExternalRequestLog();
    for (let i = 0; i < 40; i += 1) {
      recordExternalRequest(log, external({ url: `https://decoy.example/p${i}.png` }));
    }
    recordExternalRequest(
      log,
      external({ method: "POST", postData: "secret=1" }),
    );
    const posts = log.requests.filter((r) => r.method === "POST");
    expect(posts).toHaveLength(1);
    expect(posts[0]?.post_data).toBe("secret=1");
    expect(log.dropped).toBe(8);
    expect(log.dropped_data_bearing).toBe(0);
  });
});

describe("confirmTransientUnreachable", () => {
  const u = (reason: string, name: string) =>
    ({ reason, name, tag: "button", bbox: [0, 0, 10, 10] }) as never;

  test("a finding present in both walks survives; a transient does not", () => {
    // The gate blocks on these, and a control sampled mid-transition would
    // fail a page that is fine 800ms later.
    const first = [u("invisible", "Delete Groceries"), u("occluded", "Show details")];
    const second = [u("invisible", "Delete Groceries")];
    expect(confirmTransientUnreachable(first, second).map((x) => (x as { name: string }).name))
      .toEqual(["Delete Groceries"]);
  });

  test("an empty second walk clears everything", () => {
    expect(confirmTransientUnreachable([u("invisible", "X")], [])).toEqual([]);
  });

  test("matching is by reason and name together", () => {
    const first = [u("invisible", "Save")];
    const second = [u("occluded", "Save")];
    expect(confirmTransientUnreachable(first, second)).toEqual([]);
  });
});

describe("isHighPriorityWarning", () => {
  test("keeps the allowlisted defect classes, case-insensitively", () => {
    // Each string is a real Chrome/React console.warning that names a fixable
    // defect the screenshots and error scan miss.
    for (const text of [
      "Warning: Text content did not match. Server: \"A\" Client: \"B\"",
      "Hydration failed because the initial UI does not match",
      'Warning: Each child in a list should have a unique "key" prop.',
      "componentWillMount has been renamed, and is not recommended (deprecated)",
      "Refused to load the script because it violates the Content Security Policy directive",
      "The resource <x> was preloaded using link preload but not used",
      "Image with src '/a.png' has either width or height modified, but not the other",
      "An <img> has an unexpected aspect ratio given its width and height",
    ]) {
      expect(isHighPriorityWarning(text)).toBe(true);
    }
  });

  test("drops ordinary build chatter", () => {
    for (const text of [
      "Download the React DevTools for a better development experience",
      "[vite] connected.",
      "some app log nobody needs",
    ]) {
      expect(isHighPriorityWarning(text)).toBe(false);
    }
  });
});

describe("formatConsoleWarning", () => {
  test("appends the origin URL when it adds information", () => {
    expect(formatConsoleWarning("deprecated API", "https://x.example/app.js")).toBe(
      "console.warn: deprecated API (https://x.example/app.js)",
    );
  });

  test("omits the URL when the text already contains it or it is blank", () => {
    expect(
      formatConsoleWarning("failed at https://x.example/app.js", "https://x.example/app.js"),
    ).toBe("console.warn: failed at https://x.example/app.js");
    expect(formatConsoleWarning("deprecated API", "")).toBe(
      "console.warn: deprecated API",
    );
  });
});

describe("capAriaSnapshot", () => {
  test("passes null and short trees through unchanged", () => {
    expect(capAriaSnapshot(null)).toBeNull();
    expect(capAriaSnapshot("- button \"Save\"")).toBe('- button "Save"');
  });

  test("truncates an oversized tree and marks the cut", () => {
    const huge = "x".repeat(25_000);
    const out = capAriaSnapshot(huge) as string;
    expect(out.length).toBeLessThan(huge.length);
    expect(out).toContain("aria snapshot truncated");
  });
});

describe("dedupeBrokenAssets", () => {
  test("collapses url+status duplicates while preserving order", () => {
    const assets = [
      { url: "https://x/app.css", status: 404, resource_type: "stylesheet" },
      { url: "https://x/font.woff2", status: 403, resource_type: "font" },
      { url: "https://x/app.css", status: 404, resource_type: "stylesheet" },
    ];
    expect(dedupeBrokenAssets(assets)).toEqual([
      { url: "https://x/app.css", status: 404, resource_type: "stylesheet" },
      { url: "https://x/font.woff2", status: 403, resource_type: "font" },
    ]);
  });

  test("keeps the same url at a different status as distinct", () => {
    const assets = [
      { url: "https://x/a.js", status: 404, resource_type: "script" },
      { url: "https://x/a.js", status: 500, resource_type: "script" },
    ];
    expect(dedupeBrokenAssets(assets)).toHaveLength(2);
  });
});

// The local UDS has broader authority than a capture. Pin the composed policy:
// no canonical routes, mutations, credentials, or direct-network fallback.
test("local capture confines UDS requests to its audit and fails closed", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hatch-capture-"));
  const socket = join(dir, "api.sock");
  const origin = "https://artifact-capture.invalid";
  const seen: Headers[] = [];
  const paths: string[] = [];
  const server = Bun.serve({
    unix: socket,
    fetch(request) {
      seen.push(new Headers(request.headers));
      const url = new URL(request.url);
      paths.push(`${url.pathname}${url.search}`);
      return new Response("capture", { status: 200 });
    },
  });
  let handler: ((route: Route) => Promise<void>) | null = null;
  const context = {
    route(_pattern: string, callback: (route: Route) => Promise<void>) {
      handler = callback;
      return Promise.resolve();
    },
    on() {},
  };
  try {
    await attachAuditNetworkPolicy(
      { context: () => context, on() {} } as never,
      `${origin}/spaces/v2/${ROUTE_SLUG}/`,
      SLUG,
      ROUTE_SLUG,
      null,
      "local-session",
      [],
      newExternalRequestLog(),
      socket,
    );
    const dispatch = async (path: string, method = "GET") => {
      let outcome = "unhandled";
      const route = {
        request: () => ({
          url: () => `${origin}${path}`,
          method: () => method,
          resourceType: () => "document",
          postData: () => null,
          postDataBuffer: () => null,
          headers: () => ({
            authorization: "secret",
            "x-hatch-verified-uid": "spoof",
          }),
        }),
        abort: async () => {
          outcome = "aborted";
        },
        continue: async () => {
          outcome = "network";
        },
        fulfill: async (response: { status: number }) => {
          outcome = `${response.status}`;
        },
      };
      if (handler === null) throw new Error("route handler missing");
      await handler(route as never);
      return outcome;
    };
    for (const path of ["", "assets/client.js", "blobs/key", "icon.png"]) {
      expect(await dispatch(`/spaces/v2/${ROUTE_SLUG}/${path}`)).toBe("200");
    }
    expect(await dispatch(`/spaces/v2/${ROUTE_SLUG}/actions`, "POST")).toBe(
      "200",
    );
    expect(await dispatch(`/spaces/v2/${SLUG}/blobs/folder/key?version=2`)).toBe(
      "200",
    );
    expect(paths.at(-1)).toBe(
      `/spaces/v2/${ROUTE_SLUG}/blobs/folder/key?version=2`,
    );
    for (const path of [
      "/spaces/v2/another-space/blobs/key",
      `/spaces/v2/${ROUTE_SLUG}/spaces/v2/another-space/blobs/key`,
    ]) {
      expect(await dispatch(path)).toBe("aborted");
    }
    for (const path of [
      "/api/identity",
      `/spaces/v2/${SLUG}/`,
      `/spaces/v2/${SLUG}/blobs/key`,
      `/spaces/v2/${ROUTE_SLUG}/publish`,
      `/spaces/v2/${ROUTE_SLUG}/_sdk/inference`,
    ]) {
      expect(await dispatch(path, "POST")).toBe("aborted");
    }
    expect(await dispatch(`/spaces/v2/${ROUTE_SLUG}/`, "DELETE")).toBe(
      "aborted",
    );
    expect(seen).toHaveLength(6);
    for (const request of seen) {
      expect(request.get("x-hatch-audit-session")).toBe("local-session");
      expect(request.has("authorization")).toBe(false);
      expect(request.has("x-hatch-verified-uid")).toBe(false);
    }
    await server.stop(true);
    expect(await dispatch(`/spaces/v2/${ROUTE_SLUG}/`)).toBe("aborted");
  } finally {
    await server.stop(true);
    await rm(dir, { recursive: true, force: true });
  }
});
