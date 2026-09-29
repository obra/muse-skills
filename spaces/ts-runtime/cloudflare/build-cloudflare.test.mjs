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
