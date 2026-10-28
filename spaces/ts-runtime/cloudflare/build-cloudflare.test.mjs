import { afterEach, test } from "bun:test";
import { Database } from "bun:sqlite";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { buildCloudflareArtifacts } from "./build-cloudflare.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const tempRoot = path.join(__dirname, ".tmp-tests");
const activeDirs = [];

afterEach(async () => {
  for (const dir of activeDirs.splice(0)) {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

async function makeSpace({
  actionsSource,
  schemaSource = defaultSchemaSource,
  iconSource,
  jpgIconSource,
  webpIconSource,
  indexHtml = "<div></div>",
}) {
  await fs.mkdir(tempRoot, { recursive: true });
  const root = await fs.mkdtemp(path.join(tempRoot, "space-"));
  activeDirs.push(root);
  await fs.mkdir(path.join(root, "server", "src"), { recursive: true });
  await fs.mkdir(path.join(root, "client", "dist", "assets"), { recursive: true });
  await fs.mkdir(path.join(root, "drizzle"), { recursive: true });
  await fs.writeFile(
    path.join(root, "package.json"),
    JSON.stringify(
      {
        name: "daily-journal",
        type: "module",
        hatch: {
          slug: "daily-journal",
          name: "Daily Journal",
        },
      },
      null,
      2,
    ),
  );
  await fs.writeFile(path.join(root, "server", "src", "schema.ts"), schemaSource);
  await fs.writeFile(path.join(root, "server", "src", "actions.ts"), actionsSource);
  await fs.writeFile(path.join(root, "client", "dist", "index.html"), indexHtml);
  await fs.writeFile(path.join(root, "client", "dist", "assets", "app.js"), "export {};");
  if (iconSource !== undefined) {
    await fs.writeFile(path.join(root, "icon.png"), iconSource);
  }
  if (jpgIconSource !== undefined) {
    await fs.writeFile(path.join(root, "icon.jpg"), jpgIconSource);
  }
  if (webpIconSource !== undefined) {
    await fs.writeFile(path.join(root, "icon.webp"), webpIconSource);
  }
  await fs.writeFile(
    path.join(root, "drizzle", "0001_create_entries.sql"),
    "CREATE TABLE entries (id text primary key, title text not null);",
  );
  return root;
}

const defaultSchemaSource = `
import { sqliteTable, text } from "drizzle-orm/sqlite-core";

export const entries = sqliteTable("entries", {
  id: text("id").primaryKey(),
  title: text("title").notNull(),
});
`;

test("only the checked-put build switches uploads; HATCH alone and the manifest contract stay unchanged", async () => {
  const spaceDir = await makeSpace({ actionsSource: `
import { defineAction, z } from "@hatch/space-sdk";
export const Actions = { upload: defineAction({ request: z.object({}), response: z.null(),
  async handler(ctx) {
    await ctx.blobs.put(" note.txt ", "original bytes", { public: true, contentType: "Text/Plain ; Charset=UTF-8" });
    return null;
  },
}) };
` });
  await fs.writeFile(path.join(spaceDir, "space.json"), '{"anonymousAccess":true}');
  const outDir = path.join(spaceDir, "cloudflare-dist");
  const { workerPath, manifestPath } = await buildCloudflareArtifacts({ spaceDir, outDir });
  const offBytes = await fs.readFile(workerPath);
  const offManifestBytes = await fs.readFile(manifestPath);
  const offManifest = JSON.parse(offManifestBytes);
  const offWorker = (await import(pathToFileURL(workerPath).href)).default;
  let checks = 0;
  const mutations = [];
  const env = {
    DB: { prepare() { return { bind() { return this; }, async first() { return {}; }, async run() {} }; } },
    BUCKET: {
      async put(key, data, options) { mutations.push(["put", key, data, options]); },
      async delete(key) { mutations.push(["delete", key]); },
    },
    SPACE_SHORTCODE: "daily-journal-123", ASSETS: { async fetch() { return new Response(); } },
  };
  const request = () => new Request("https://daily-journal-123.example/actions", {
    method: "POST", body: '{"action":"upload","args":{}}',
    headers: { "content-type": "application/json", "x-cloudflare-spaces-viewer-authenticated": "1",
      "x-cloudflare-spaces-share-id": "share", "x-cloudflare-spaces-space-slug": "daily-journal", "x-cloudflare-spaces-space-id": "123",
      "x-cloudflare-spaces-viewer-fbid": "owner", "x-cloudflare-spaces-owner-fbid": "owner", "x-cloudflare-spaces-is-owner": "true",
      "x-cloudflare-spaces-token-exp": "2000000000", "x-cloudflare-spaces-token-jti": "test" },
  });
  const execution = { props: { HATCH: { async checkUpload(input) {
    checks++;
    assert.deepEqual(input, { bytes: new TextEncoder().encode("original bytes"), contentType: "text/plain", key: "blobs/public/note.txt" });
    return { verdict: "allow", checkId: "checked", receipt: "not-for-storage" };
  } } }, waitUntil() {} };
  assert.equal((await offWorker.fetch(request(), env, execution)).status, 200);
  assert.equal(checks, 0);
  assert.deepEqual(mutations, [
    ["delete", "blobs/private/note.txt"],
    ["put", "blobs/public/note.txt", "original bytes", { httpMetadata: { contentType: "Text/Plain ; Charset=UTF-8" } }],
  ]);
  await buildCloudflareArtifacts({ spaceDir, outDir, checkedPut: true });
  const onManifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
  assert.equal(onManifest.runtime, "hatch-ts-cloudflare-v1");
  assert.deepEqual({ ...onManifest, workerJs: "" }, { ...offManifest, workerJs: "" });
  const onPath = path.join(outDir, "checked-worker.js");
  await fs.copyFile(workerPath, onPath);
  const onWorker = (await import(pathToFileURL(onPath).href)).default;
  mutations.length = 0;
  assert.equal((await onWorker.fetch(request(), env, execution)).status, 200);
  assert.equal(checks, 1);
  assert.deepEqual(mutations, [
    ["delete", "blobs/private/note.txt"],
    ["put", "blobs/public/note.txt", new TextEncoder().encode("original bytes"), { httpMetadata: { contentType: "Text/Plain ; Charset=UTF-8" }, customMetadata: { check_id: "checked" } }],
  ]);
  mutations.length = 0;
  const unavailable = await onWorker.fetch(request(), env, { waitUntil() {} });
  assert.equal(unavailable.status, 409);
  assert.equal((await unavailable.json()).code, "action_outcome_unknown");
  assert.deepEqual(mutations, []);
  await buildCloudflareArtifacts({ spaceDir, outDir, checkedPut: false });
  assert.deepEqual(await fs.readFile(workerPath), offBytes);
  assert.deepEqual(await fs.readFile(manifestPath), offManifestBytes);
}, 30_000);

test("built Cloudflare worker forwards invocation and action authority on tool callbacks", async () => {
  const spaceDir = await makeSpace({
    actionsSource: `
import { defineAction, z, type ActionsModule } from "@hatch/space-sdk";

export const Actions = {
  searchNews: defineAction({
    request: z.object({}),
    response: z.object({ engine: z.string() }),
    async handler(ctx) {
      const result = await ctx.tool.web_search("latest AI news", { language_code: "en" });
      return { engine: result.search_engines?.[0] ?? "" };
    },
  }),
} satisfies ActionsModule;
`,
  });
  const { workerPath } = await buildCloudflareArtifacts({
    spaceDir,
    outDir: path.join(spaceDir, "cloudflare-dist"),
  });
  const workerModule = await import(
    `${pathToFileURL(workerPath).href}?authority-test=${Date.now()}`
  );
  assert.equal(typeof workerModule.default?.fetch, "function");

  const callbackRequests = [];
  const sqlite = new Database(":memory:");
  sqlite.exec(`CREATE TABLE __hatch_shared_state (id INTEGER PRIMARY KEY, version INTEGER, accepting INTEGER);
    INSERT INTO __hatch_shared_state VALUES (1, 1, 1);
    CREATE TABLE __hatch_shared_invocations (id TEXT PRIMARY KEY, kind TEXT, started_at_ms INTEGER);`);
  const db = { prepare(sql) {
    let values = [];
    return {
      bind(...args) { values = args; return this; },
      async run() { return sqlite.prepare(sql).run(...values); },
      async first() { return sqlite.prepare(sql).get(...values); },
    };
  } };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const request = input instanceof Request ? input : new Request(input, init);
    callbackRequests.push({
      url: request.url,
      authorization: request.headers.get("authorization"),
      body: await request.clone().json(),
    });
    return new Response(
      JSON.stringify({
        content: null,
        summary: {
          top: [
            {
              title: "AI result",
              url: "https://example.com/ai",
              excerpt: "A useful result.",
            },
          ],
        },
        metadata: { perplexity_request_id: "pplx-test-1" },
        search_engines: ["perplexity"],
        model: null,
        usage: null,
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  };

  try {
    const now = Date.now();
    const response = await workerModule.default.fetch(
      new Request("https://space.example/actions", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-cloudflare-spaces-viewer-authenticated": "1",
          "x-cloudflare-spaces-share-id": "share-1",
          "x-cloudflare-spaces-space-slug": "daily-journal",
          "x-cloudflare-spaces-space-id": "space-1",
          "x-cloudflare-spaces-viewer-fbid": "viewer-1",
          "x-cloudflare-spaces-owner-fbid": "viewer-1",
          "x-cloudflare-spaces-is-owner": "true",
          "x-cloudflare-spaces-token-exp": String(now + 60_000),
          "x-cloudflare-spaces-token-jti": "token-1",
        },
        body: JSON.stringify({
          action: "searchNews",
          actionCallId: "action-invocation-1",
          args: {},
        }),
      }),
      {
        SPACE_SLUG: "daily-journal",
        SPACE_SHORTCODE: "daily-journal-space-1",
        SPACE_ACTION_SPACE_SLUG: "daily-journal",
        SPACE_ACTION_VM_ID: "00000000-0000-4000-8000-000000000001",
        SPACE_ACTION_EDGE_HOST: "hatch.test-only.metaaivm.com",
        SPACE_ACTION_NOTARY_TOKEN: "test-notary-token",
        SPACE_ACTION_CREDENTIAL_EXPIRES_AT_MS: String(now + 60_000),
        SPACE_ACTION_CREDENTIAL_REFRESH_AFTER_MS: String(now + 30_000),
        DB: db,
        ASSETS: { fetch: async () => new Response(null, { status: 404 }) },
        BUCKET: {},
      },
      { waitUntil() {} },
    );
    assert.equal(response.status, 200, await response.text());
  } finally {
    globalThis.fetch = originalFetch;
    sqlite.close();
  }

  assert.equal(callbackRequests.length, 1);
  const callback = callbackRequests[0];
  assert.equal(callback.authorization, "endorsement.test-notary-token");
  assert.match(callback.url, /\/_sdk\/tool-call\?vm_id=/);
  assert.equal(callback.body.capability, "tool_call");
  assert.equal(callback.body.payload.actionInvocationId, "action-invocation-1");
  assert.equal(callback.body.payload.actionName, "searchNews");
});

test.each([false, true])("view-only recipients run actions read-only (checkedPut=%s)", async (checkedPut) => {
  const spaceDir = await makeSpace({
    actionsSource: `
import { eq, sql } from "drizzle-orm";
import { defineAction, z, type ActionsModule } from "@hatch/space-sdk";
import { entries } from "./schema";

export const Actions = {
  listEntries: defineAction({
    request: z.object({}),
    response: z.object({ titles: z.array(z.string()) }),
    async handler(ctx) {
      const rows = await ctx.db().select().from(entries);
      return { titles: rows.map(row => row.title) };
    },
  }),
  findEntry: defineAction({
    request: z.object({ title: z.string() }),
    response: z.object({ found: z.boolean() }),
    async handler(ctx, args) {
      const rows = await ctx.db().select().from(entries).where(eq(entries.title, args.title));
      return { found: rows.length > 0 };
    },
  }),
  addEntry: defineAction({
    request: z.object({ title: z.string() }),
    response: z.object({ ok: z.boolean() }),
    async handler(ctx, args) {
      await ctx.db().insert(entries).values({ id: args.title, title: args.title });
      return { ok: true };
    },
  }),
  listEntriesAfterSchemaCheck: defineAction({
    request: z.object({}),
    response: z.object({ columns: z.array(z.string()), titles: z.array(z.string()) }),
    async handler(ctx) {
      // A builder seed helper's load-time check: read the schema, then the rows.
      const columns = await ctx.db().all<{ name: string }>(sql\`PRAGMA table_info(entries)\`);
      const rows = await ctx.db().select().from(entries);
      return { columns: columns.map(column => column.name), titles: rows.map(row => row.title) };
    },
  }),
  runSql: defineAction({
    request: z.object({ statement: z.string() }),
    response: z.object({ ok: z.boolean() }),
    async handler(ctx, args) {
      await ctx.db().run(sql.raw(args.statement));
      return { ok: true };
    },
  }),
  saveBlob: defineAction({
    request: z.object({}),
    response: z.object({ ok: z.boolean() }),
    async handler(ctx) {
      await ctx.blobs.put("note.txt", "hello");
      return { ok: true };
    },
  }),
} satisfies ActionsModule;
`,
  });
  const { workerPath } = await buildCloudflareArtifacts({
    spaceDir,
    outDir: path.join(spaceDir, "cloudflare-dist"),
    checkedPut,
  });
  const workerModule = await import(
    `${pathToFileURL(workerPath).href}?read-only-test=${Date.now()}`
  );

  const sqlite = new Database(":memory:");
  sqlite.exec(`CREATE TABLE __hatch_shared_state (id INTEGER PRIMARY KEY, version INTEGER, accepting INTEGER);
    INSERT INTO __hatch_shared_state VALUES (1, 1, 1);
    CREATE TABLE __hatch_shared_invocations (id TEXT PRIMARY KEY, kind TEXT, started_at_ms INTEGER);
    CREATE TABLE entries (id text primary key, title text not null);
    INSERT INTO entries VALUES ('milk', 'milk');`);
  // Like D1, a statement needs exactly as many bindings as it has parameters.
  const statement = (sql, values) => {
    const prepared = sqlite.prepare(sql);
    if (prepared.paramsCount !== values.length) throw new Error("Wrong number of parameter bindings for SQL query.");
    return prepared;
  };
  const db = { prepare(sql) {
    let values = [];
    return {
      bind(...args) { values = args; return this; },
      async run() { return statement(sql, values).run(...values); },
      async first() { return statement(sql, values).get(...values); },
      async all() { return { success: true, results: statement(sql, values).all(...values), meta: {} }; },
      async raw() { return statement(sql, values).values(...values); },
    };
  } };
  const checks = [];
  const mutations = [];
  const env = {
    SPACE_SLUG: "daily-journal",
    SPACE_SHORTCODE: "daily-journal-space-1",
    DB: db,
    ASSETS: { fetch: async () => new Response(null, { status: 404 }) },
    BUCKET: {
      async put(...args) { mutations.push(["put", ...args]); },
      async delete(...args) { mutations.push(["delete", ...args]); },
    },
  };
  // The dispatcher's viewer headers for a recipient who is not the owner.
  const call = (pathname, action, args) => workerModule.default.fetch(
    new Request(`https://space.example${pathname}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-cloudflare-spaces-viewer-authenticated": "1",
        "x-cloudflare-spaces-share-id": "share-1",
        "x-cloudflare-spaces-space-slug": "daily-journal",
        "x-cloudflare-spaces-space-id": "space-1",
        "x-cloudflare-spaces-viewer-fbid": "viewer-2",
        "x-cloudflare-spaces-owner-fbid": "viewer-1",
        "x-cloudflare-spaces-is-owner": "false",
        "x-cloudflare-spaces-token-exp": String(Date.now() + 60_000),
        "x-cloudflare-spaces-token-jti": "token-2",
      },
      body: JSON.stringify({ action, args }),
    }),
    env,
    { waitUntil() {}, props: { HATCH: { async checkUpload(request) {
      checks.push(request);
      return { verdict: "allow", checkId: "checked", receipt: null };
    } } } },
  );
  const titles = () => sqlite.prepare("SELECT title FROM entries ORDER BY title").values().flat();

  try {
    const readOnlyPath = "/__hatch/read-only-actions";
    const listed = await call(readOnlyPath, "listEntries", {});
    assert.equal(listed.status, 200, await listed.clone().text());
    assert.deepEqual((await listed.json()).data, { titles: ["milk"] });
    const found = await call(readOnlyPath, "findEntry", { title: "milk" });
    assert.equal(found.status, 200, await found.clone().text());
    assert.deepEqual((await found.json()).data, { found: true });

    // Schema lookups are reads: seed helpers run them before loading rows.
    const checked = await call(readOnlyPath, "listEntriesAfterSchemaCheck", {});
    assert.equal(checked.status, 200, await checked.clone().text());
    assert.deepEqual((await checked.json()).data, { columns: ["id", "title"], titles: ["milk"] });
    for (const statement of ["PRAGMA main.index_list('entries')", "pragma table_list;"]) {
      const read = await call(readOnlyPath, "runSql", { statement });
      assert.equal(read.status, 200, `${statement}: ${await read.text()}`);
    }

    for (const [action, args] of [
      ["addEntry", { title: "eggs" }],
      ["runSql", { statement: "WITH doomed AS (SELECT 1) DELETE FROM entries" }],
      // SQLite reads the CTE name as one identifier and runs the DELETE.
      ["runSql", { statement: "WITH \u00e9SELECT AS (SELECT 1) DELETE FROM entries" }],
      ["runSql", { statement: "/* SELECT */ UPDATE entries SET title = 'select'" }],
      ["runSql", { statement: "PRAGMA user_version = 1" }],
      ["saveBlob", {}],
    ]) {
      const denied = await call(readOnlyPath, action, args);
      assert.equal(denied.status, 403, `${action} ${JSON.stringify(args)}: ${await denied.text()}`);
    }
    assert.deepEqual(titles(), ["milk"]);
    assert.equal(sqlite.prepare("PRAGMA user_version").get().user_version, 0);
    assert.deepEqual(checks, []);
    assert.deepEqual(mutations, []);

    // A use grant arrives on /actions, where the same write succeeds.
    const added = await call("/actions", "addEntry", { title: "eggs" });
    assert.equal(added.status, 200, await added.clone().text());
    assert.deepEqual(titles(), ["eggs", "milk"]);
    const saved = await call("/actions", "saveBlob", {});
    assert.equal(saved.status, 200, await saved.clone().text());
    assert.equal(checks.length, checkedPut ? 1 : 0);
    assert.deepEqual(mutations.map(([method, key]) => [method, key]).sort(), [
      ["delete", "blobs/public/note.txt"], ["put", "blobs/private/note.txt"],
    ]);
  } finally {
    sqlite.close();
  }
});

test("preserves root PNG and WebP icons in Cloudflare assets and favicon links", async () => {
  for (const extension of ["png", "webp"]) {
    const iconBytes = Buffer.from(`original ${extension} icon`);
    const spaceDir = await makeSpace({
      iconSource: extension === "png" ? iconBytes : undefined,
      webpIconSource: extension === "webp" ? iconBytes : undefined,
      indexHtml: "<html><head><title>Daily Journal</title></head><body></body></html>",
      actionsSource: `
import { defineAction, z, type ActionsModule } from "@hatch/space-sdk";

export const Actions = {
  ping: defineAction({
    request: z.object({}),
    response: z.object({ ok: z.boolean() }),
    async handler() {
      return { ok: true };
    },
  }),
} satisfies ActionsModule;
`,
    });
    const { manifestPath } = await buildCloudflareArtifacts({
      spaceDir,
      outDir: path.join(spaceDir, "cloudflare-dist"),
    });

    const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
    const iconFile = manifest.clientFiles.find((file) => file.path === `assets/icon.${extension}`);
    assert.equal(iconFile.contentType, `image/${extension}`);
    assert.deepEqual(Buffer.from(iconFile.contentBase64, "base64"), iconBytes);

    const indexFile = manifest.clientFiles.find((file) => file.path === "index.html");
    const indexHtml = Buffer.from(indexFile.contentBase64, "base64").toString("utf8");
    assert.ok(indexHtml.includes(`<link rel="icon" type="image/${extension}" href="./assets/icon.${extension}">`));
  }
});

test("rejects Node runtime imports during Worker typecheck", async () => {
  const spaceDir = await makeSpace({
    actionsSource: `
import { readFileSync } from "node:fs";
import { defineAction, z, type ActionsModule } from "@hatch/space-sdk";

export const Actions = {
  readLocalFile: defineAction({
    request: z.object({ path: z.string() }),
    response: z.object({ contents: z.string() }),
    async handler(_ctx, args) {
      return { contents: readFileSync(args.path, "utf8") };
    },
  }),
} satisfies ActionsModule;
`,
  });

  await assert.rejects(
    () =>
      buildCloudflareArtifacts({
        spaceDir,
        outDir: path.join(spaceDir, "cloudflare-dist"),
      }),
    /Cannot find module 'node:fs'/,
  );
});

test("builds privileged actions from the generated contract without the VM handlers", async () => {
  const spaceDir = await makeSpace({
    actionsSource: `
import { defineAction, z, type ActionsModule } from "@hatch/space-sdk";
import { privileged } from "@space/privileged";

export const Actions = {
  countNotes: defineAction({
    request: z.object({}),
    response: z.object({ count: z.number() }),
    privileged: [privileged.readNotes],
    async handler(ctx) {
      const { notes } = await ctx.executePrivileged(privileged.readNotes, {});
      return { count: notes.length };
    },
  }),
} satisfies ActionsModule;
`,
  });
  const contract = `{
  readNotes: {
    request: z.object({}),
    response: z.object({ notes: z.array(z.string()) }),
  },
}`;
  await fs.writeFile(
    path.join(spaceDir, "server", "src", "privileged.ts"),
    `
import { readFileSync } from "node:fs";
import { definePrivilegedContracts, definePrivilegedHandlers, z } from "@hatch/space-sdk";

export const privileged = definePrivilegedContracts(${contract});

export const privilegedHandlers = definePrivilegedHandlers(privileged, {
  readNotes() {
    return { notes: readFileSync(\`\${process.env.HOME}/vm-only-notes.txt\`, "utf8").split("\\n") };
  },
});
`,
  );
  await fs.mkdir(path.join(spaceDir, "server", ".generated"));
  await fs.writeFile(
    path.join(spaceDir, "server", ".generated", "privileged.contract.ts"),
    `import { definePrivilegedContracts, z } from "@hatch/space-sdk";

export const privileged = definePrivilegedContracts(${contract});
`,
  );

  const { workerPath } = await buildCloudflareArtifacts({
    spaceDir,
    outDir: path.join(spaceDir, "cloudflare-dist"),
  });
  assert.doesNotMatch(await fs.readFile(workerPath, "utf8"), /vm-only-notes/);
});

test("rejects unbranded hand-authored action objects during typecheck", async () => {
  const spaceDir = await makeSpace({
    actionsSource: `
import { z, type ActionsModule } from "@hatch/space-sdk";

export const Actions = {
  unbranded: {
    request: z.object({}),
    response: z.object({ ok: z.boolean() }),
    async handler() {
      return { ok: true };
    },
  },
} satisfies ActionsModule;
`,
  });

  await assert.rejects(
    () =>
      buildCloudflareArtifacts({
        spaceDir,
        outDir: path.join(spaceDir, "cloudflare-dist"),
      }),
    /Property '__brand' is missing/,
  );
});

test("rejects transaction use from the portable DB type", async () => {
  const spaceDir = await makeSpace({
    actionsSource: `
import { defineAction, z, type ActionsModule } from "@hatch/space-sdk";
import * as schema from "./schema";

export const Actions = {
  writeEntry: defineAction({
    request: z.object({ title: z.string() }),
    response: z.object({ ok: z.boolean() }),
    async handler(ctx, args) {
      await ctx.db<typeof schema>().transaction(async () => args.title);
      return { ok: true };
    },
  }),
} satisfies ActionsModule;
`,
  });

  await assert.rejects(
    () =>
      buildCloudflareArtifacts({
        spaceDir,
        outDir: path.join(spaceDir, "cloudflare-dist"),
      }),
    /Property 'transaction' does not exist/,
  );
});
