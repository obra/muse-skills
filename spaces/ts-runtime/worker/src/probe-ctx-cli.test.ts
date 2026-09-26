import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildProbeCtx } from "./probe-ctx-cli";
import { createToolClient, type SearchRequest } from "./web_search";
import { decodeWebSearchFrame, encodeWebSearchFrame } from "./web_search_frame";

const ENV_NAMES = [
  "HATCH_SPACE_INFERENCE_SOCKET",
  "HATCH_SPACE_WEB_SEARCH_SOCKET",
  "HATCH_SPACE_SLUG",
  "JARVIS_RUNTIME_CONTEXT_TOKEN",
] as const;

const originalEnv = Object.fromEntries(
  ENV_NAMES.map((name) => [name, process.env[name]]),
) as Record<(typeof ENV_NAMES)[number], string | undefined>;

afterEach(() => {
  for (const name of ENV_NAMES) {
    const value = originalEnv[name];
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

type MockServer = {
  socketPath: string;
  request: Promise<SearchRequest>;
  close(): Promise<void>;
};

async function startMockServer(): Promise<MockServer> {
  const directory = await mkdtemp(join(tmpdir(), "hatch-space-search-test-"));
  const socketPath = join(directory, "search.sock");
  let resolveRequest: (request: SearchRequest) => void = () => {};
  let rejectRequest: (error: Error) => void = () => {};
  const request = new Promise<SearchRequest>((resolve, reject) => {
    resolveRequest = resolve;
    rejectRequest = reject;
  });
  const server: Server = createServer((socket) => {
    const chunks: Buffer[] = [];
    socket.on("data", (chunk) => {
      chunks.push(Buffer.from(chunk));
      const frame = Buffer.concat(chunks);
      if (frame.length < 4 || frame.length < frame.readUInt32BE(0) + 4) return;
      try {
        resolveRequest(decodeWebSearchFrame<SearchRequest>(frame));
        socket.end(
          encodeWebSearchFrame({
            ok: true,
            result: {
              kind: "search",
              content: null,
              summary: {
                top: [
                  {
                    title: "Example",
                    url: "https://example.com/result",
                    excerpt: "Example result",
                    rank: 0,
                  },
                ],
              },
              metadata: { request_id: "upstream-1" },
              search_engines: ["perplexity"],
            },
          }),
        );
      } catch (error) {
        rejectRequest(error instanceof Error ? error : new Error(String(error)));
        socket.destroy();
      }
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  });

  return {
    socketPath,
    request,
    async close() {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
      await rm(directory, { recursive: true, force: true });
    },
  };
}

describe("builder probe web search authority", () => {
  test("requires a daemon-minted runtime context token", () => {
    delete process.env.JARVIS_RUNTIME_CONTEXT_TOKEN;
    expect(() => buildProbeCtx(new Set())).toThrow(
      "missing required builder probe environment variable JARVIS_RUNTIME_CONTEXT_TOKEN",
    );

    process.env.JARVIS_RUNTIME_CONTEXT_TOKEN = "   ";
    expect(() => buildProbeCtx(new Set())).toThrow(
      "missing required builder probe environment variable JARVIS_RUNTIME_CONTEXT_TOKEN",
    );
  });

  test("forwards the exact token with one shared probe invocation id", async () => {
    const mock = await startMockServer();
    try {
      process.env.HATCH_SPACE_WEB_SEARCH_SOCKET = mock.socketPath;
      process.env.HATCH_SPACE_SLUG = "news-space";
      process.env.JARVIS_RUNTIME_CONTEXT_TOKEN = "synthetic-runtime-token";
      const ctx = buildProbeCtx(new Set());

      const result = await ctx.tool.web_search("latest AI news");
      const request = await mock.request;

      expect(request.slug).toBe("news-space");
      expect(request.action_invocation_id).toBe(ctx.invocationId);
      expect(request.action_invocation_id?.startsWith("probe-")).toBe(true);
      expect(request.action_name).toBe("__builder_probe__");
      expect(request.builder_probe_authority).toEqual({
        runtime_context_token: "synthetic-runtime-token",
      });
      expect(request.tool_method).toBe("web_search");
      expect(request.primary_query.query).toBe("latest AI news");
      expect(result.search_engines).toEqual(["perplexity"]);
      expect(result.content.results).toHaveLength(1);
    } finally {
      await mock.close();
    }
  });

  test("ordinary actions never copy an ambient probe token", async () => {
    const mock = await startMockServer();
    try {
      process.env.HATCH_SPACE_WEB_SEARCH_SOCKET = mock.socketPath;
      process.env.HATCH_SPACE_SLUG = "news-space";
      process.env.JARVIS_RUNTIME_CONTEXT_TOKEN = "ambient-token-must-not-cross";

      await createToolClient("action-1", "refresh", "root-1").web_search(
        "latest AI news",
      );
      const request = await mock.request;

      expect(request.action_invocation_id).toBe("action-1");
      expect(request.action_name).toBe("refresh");
      expect(request.root_request_id).toBe("root-1");
      expect(request.builder_probe_authority).toBeUndefined();
    } finally {
      await mock.close();
    }
  });
});
