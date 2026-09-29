import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createWorker } from "./src/worker-runtime";
import { defineAction, SpaceActionAuthRefreshRequiredError, z } from "./src/sdk";
import { admitSharedAction, sharedStateAvailable } from "./src/shared-state";
import { createActionClient, shouldRetryAction } from "../sdk/src/client";

const databases: Database[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });

function fixture() {
  const sqlite = new Database(":memory:");
  databases.push(sqlite);
  // CP binds the share shortcode; the worker embeds the canonical app slug.
  // Viewer identity still comes from dispatcher-verified context.
  // Protocol 1 storage, provisioned by the control plane before worker upload.
  sqlite.exec(`CREATE TABLE __hatch_shared_state (id INTEGER PRIMARY KEY, version INTEGER, accepting INTEGER);
    INSERT INTO __hatch_shared_state VALUES (1, 1, 1);
    CREATE TABLE __hatch_shared_invocations (id TEXT PRIMARY KEY, kind TEXT, started_at_ms INTEGER);
    CREATE TABLE entries (value TEXT);`);
  const db = { prepare(sql: string) {
    let values: (string | number | null)[] = [];
    return {
      bind(...args: unknown[]) { values = args as typeof values; return this; },
      async run() { return sqlite.prepare(sql).run(...values); },
      async first<T>() { return sqlite.prepare(sql).get(...values) as T | null; },
    };
  } };
  let assetReads = 0;
  const env = {
    DB: db,
    SPACE_SHORTCODE: "demo-123",
    ASSETS: { async fetch() { assetReads++; return new Response("private app"); } },
    BUCKET: {} as Parameters<ReturnType<typeof createWorker>["fetch"]>[1]["BUCKET"],
  };
  const pending: Promise<unknown>[] = [];
  const execution = { waitUntil(promise: Promise<unknown>) { pending.push(promise); } };
  return { sqlite, db, env, execution, pending, assetReads: () => assetReads };
}

function request(body?: unknown, overrides: Record<string, string> = {}) {
  return new Request(`https://demo-123.example/${body === undefined ? "" : "actions"}`, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      "content-type": "application/json",
      "x-cloudflare-spaces-viewer-authenticated": "1",
      "x-cloudflare-spaces-share-id": "share-1",
      "x-cloudflare-spaces-space-slug": "demo",
      "x-cloudflare-spaces-space-id": "123",
      "x-cloudflare-spaces-viewer-fbid": "owner",
      "x-cloudflare-spaces-owner-fbid": "owner",
      "x-cloudflare-spaces-is-owner": "true",
      "x-cloudflare-spaces-token-exp": "2000000000",
      "x-cloudflare-spaces-token-jti": "test-jti",
      ...overrides,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

test("stateful assets, blobs, and actions require viewer context bound to this artifact", async () => {
  const f = fixture();
  let calls = 0;
  let blobReads = 0;
  f.env.BUCKET.get = async key => {
    blobReads++;
    return { key, size: 10, etag: "saved", uploaded: new Date(),
      body: new Response("saved note").body, writeHttpMetadata() {} };
  };
  const blobRequest = (headers: Headers) => new Request(
    "https://demo-123.example/blobs/public/bm90ZQ", { headers });
  const worker = createWorker({ save: defineAction({ request: z.object({}), response: z.number(),
    handler: async (ctx) => { expect(ctx.slug).toBe("demo-canonical-slug-that-is-longer-than-thirty-eight-characters"); return ++calls; } }) }, "demo-canonical-slug-that-is-longer-than-thirty-eight-characters");
  for (const headers of [
    { "x-cloudflare-spaces-viewer-authenticated": "0" },
    { "x-cloudflare-spaces-space-id": "different" },
    { "x-cloudflare-spaces-viewer-fbid": "guest" },
  ]) {
    expect((await worker.fetch(request(undefined, headers), f.env, f.execution)).status).toBe(401);
    expect((await worker.fetch(blobRequest(request(undefined, headers).headers), f.env, f.execution)).status).toBe(401);
    expect((await worker.fetch(request({ kind: "catalog" }, headers), f.env, f.execution)).status).toBe(401);
    expect((await worker.fetch(request({ action: "save", args: {} }, headers), f.env, f.execution)).status).toBe(401);
  }
  expect(calls).toBe(0);
  expect(f.assetReads()).toBe(0);
  expect(blobReads).toBe(0);
  const catalog = await worker.fetch(request({ kind: "catalog" }), f.env, f.execution);
  expect(catalog.status).toBe(200);
  expect(catalog.headers.get("cache-control")).toBe("no-store");
  expect(await catalog.json()).toMatchObject({ data: [{ slug: "demo-canonical-slug-that-is-longer-than-thirty-eight-characters", action: "save", request_schema: { type: "object" } }] });
  expect(calls).toBe(0);
  const authorized = await worker.fetch(request(), f.env, f.execution);
  expect(authorized.status).toBe(200);
  expect(authorized.headers.get("cache-control")).toBe("no-store");
  const blob = await worker.fetch(blobRequest(request().headers), f.env, f.execution);
  expect(blob.status).toBe(200);
  expect(blob.headers.get("cache-control")).toBe("no-store");
  expect(blob.headers.get("content-security-policy")).toBe("sandbox");
  expect(blob.headers.get("x-content-type-options")).toBe("nosniff");
  expect(await blob.text()).toBe("saved note");
  const saved = await worker.fetch(request({ action: "save", args: {} }), f.env, f.execution);
  expect(saved.status).toBe(200);
  expect(await saved.json()).toMatchObject({ data: 1 });
  expect(calls).toBe(1);
});

test("freezing refuses later writes and retains admitted work until completion", async () => {
  const { sqlite, db } = fixture();
  const complete = await admitSharedAction(db);
  sqlite.run("UPDATE __hatch_shared_state SET accepting = 0");
  await expect(admitSharedAction(db)).rejects.toThrow();
  expect(await sharedStateAvailable(db)).toBe(false);
  expect(sqlite.query("SELECT count(*) AS n FROM __hatch_shared_invocations").get()).toEqual({ n: 1 });
  await complete();
  expect(sqlite.query("SELECT count(*) AS n FROM __hatch_shared_invocations").get()).toEqual({ n: 0 });
  sqlite.run("UPDATE __hatch_shared_state SET accepting = 1");
  sqlite.run("INSERT INTO __hatch_shared_invocations VALUES ('deployment', 'deploy', 0)");
  await expect(admitSharedAction(db)).rejects.toThrow();
});

test("a failed admission reply cannot strand work that never reached its handler", async () => {
  for (const committed of [false, true]) {
    const f = fixture();
    const prepare = f.db.prepare;
    f.db.prepare = sql => {
      const statement = prepare(sql);
      if (sql.startsWith("INSERT INTO __hatch_shared_invocations")) {
        const first = statement.first;
        statement.first = async <T>() => {
          if (committed) await first<T>();
          throw new Error("Lost admission reply");
        };
      }
      return statement;
    };
    await expect(admitSharedAction(f.db)).rejects.toThrow("Lost admission reply");
    expect(f.sqlite.query("SELECT count(*) AS n FROM __hatch_shared_invocations").get()).toEqual({ n: 0 });
    f.db.prepare = prepare;
    const complete = await admitSharedAction(f.db);
    await complete();
  }
});

test("request lifetime retains disconnected work through its final admission cleanup", async () => {
  const f = fixture();
  const started = Promise.withResolvers<void>();
  const finishWork = Promise.withResolvers<void>();
  const cleaning = Promise.withResolvers<void>();
  const finishCleanup = Promise.withResolvers<void>();
  const prepare = f.db.prepare;
  f.db.prepare = sql => {
    const statement = prepare(sql);
    if (sql.startsWith("DELETE FROM __hatch_shared_invocations")) {
      const run = statement.run;
      statement.run = async () => {
        cleaning.resolve();
        await finishCleanup.promise;
        return run();
      };
    }
    return statement;
  };
  const worker = createWorker({ save: defineAction({ request: z.object({}), response: z.number(),
    async handler() {
      started.resolve();
      await finishWork.promise;
      f.sqlite.run("INSERT INTO entries VALUES ('saved')");
      return 1;
    } }) }, "demo");
  const controller = new AbortController();
  const response = worker.fetch(new Request(request({ action: "save", args: {} }), {
    signal: controller.signal,
  }), f.env, f.execution);
  expect(f.pending.length).toBe(1);
  let settled = false;
  const lifetime = Promise.all(f.pending).then(() => { settled = true; });
  await started.promise;
  controller.abort();
  f.sqlite.run("UPDATE __hatch_shared_state SET accepting = 0");
  await expect(admitSharedAction(f.db)).rejects.toThrow();
  finishWork.resolve();
  await cleaning.promise;
  expect(settled).toBe(false);
  expect(f.sqlite.query("SELECT count(*) AS n FROM entries").get()).toEqual({ n: 1 });
  expect(f.sqlite.query("SELECT count(*) AS n FROM __hatch_shared_invocations").get()).toEqual({ n: 1 });
  finishCleanup.resolve();
  await lifetime;
  expect((await response).status).toBe(200);
  expect(f.sqlite.query("SELECT count(*) AS n FROM __hatch_shared_invocations").get()).toEqual({ n: 0 });
});

test("a write followed by failure cannot authorize an automatic replay", async () => {
  for (const error of [new Error("private diagnostics"), new SpaceActionAuthRefreshRequiredError("notary_expired")]) {
    const f = fixture();
    const worker = createWorker({ save: defineAction({ request: z.object({}), response: z.object({}),
      async handler() { f.sqlite.run("INSERT INTO entries VALUES ('saved')"); throw error; } }) }, "demo");
    const response = await worker.fetch(request({ action: "save", args: {} }), f.env, f.execution);
    const body = await response.json();
    expect([401, 409]).toContain(response.status);
    expect(body.retrySafe).not.toBe(true);
    expect(JSON.stringify(body)).not.toContain("private diagnostics");
    expect(f.sqlite.query("SELECT count(*) AS n FROM entries").get()).toEqual({ n: 1 });
    expect(f.sqlite.query("SELECT count(*) AS n FROM __hatch_shared_invocations").get()).toEqual({ n: 0 });
  }
});

test("guests can save collaborative data but cannot use the owner's VM tools", async () => {
  const f = fixture();
  const worker = createWorker({
    save: defineAction({ request: z.object({}), response: z.string(), async handler(ctx) {
      return ctx.viewer!.viewerFbid;
    } }),
    weather: defineAction({ request: z.object({}), response: z.unknown(), async handler(ctx) {
      return ctx.tool.weather("New York");
    } }),
  }, "demo");
  const guest = { "x-cloudflare-spaces-viewer-fbid": "guest", "x-cloudflare-spaces-is-owner": "false" };
  const saved = await worker.fetch(request({ action: "save", args: {} }, guest), f.env, f.execution);
  expect(await saved.json()).toEqual({ data: "guest", version: 1 });
  expect((await worker.fetch(request({ action: "weather", args: {} }, guest), f.env, f.execution)).status).toBe(403);
});

test("malformed and oversized payloads never reach a handler or shared admission", async () => {
  const f = fixture();
  let calls = 0;
  const worker = createWorker({ save: defineAction({ request: z.unknown(), response: z.number(), handler: async () => ++calls }) }, "demo");
  for (const body of [null, [], { action: "save", args: {}, actionCallId: "invalid call id" },
    { action: "save", args: "x".repeat(12 * 1024 * 1024) }]) {
    expect([400, 413]).toContain((await worker.fetch(request(body), f.env, f.execution)).status);
  }
  expect(calls).toBe(0);
  expect(f.sqlite.query("SELECT count(*) AS n FROM __hatch_shared_invocations").get()).toEqual({ n: 0 });
});

test("the client retries only an explicit pre-invocation failure, never a lost response", async () => {
  for (const [status, retrySafe, expected] of [[503, true, true], [503, false, false], [409, true, false], [502, false, false]] as const) {
    const client = createActionClient({ endpoint: "https://example.test/actions", fetch: async () =>
      Response.json({ error: "Unavailable", retrySafe }, { status }) }, "demo");
    try { await client.save!({}); throw new Error("expected action failure"); }
    catch (error) { expect(shouldRetryAction(0, error)).toBe(expected); }
  }
  const disconnected = createActionClient({ endpoint: "https://example.test/actions", fetch: async () => {
    throw new TypeError("Connection lost after sending the request");
  } });
  try { await disconnected.save!({}); throw new Error("expected connection failure"); }
  catch (error) { expect(shouldRetryAction(0, error)).toBe(false); }
});
