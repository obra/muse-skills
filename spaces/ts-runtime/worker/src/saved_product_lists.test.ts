import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type Server, type Socket } from "node:net";

import type { BlobClient, BlobPutData, LocalViewer } from "@hatch/space-sdk";

import {
  type SavedProductListItem,
  type SavedProductLists,
  SavedProductListsUnavailableError,
  mergeSavedProductListsCache,
} from "../../sdk/src/saved_product_lists";
import { readDeclaredSavedProductLists, readSavedProductLists } from "./saved_product_lists";

const tempDirs: string[] = [];
const servers: Server[] = [];
const originalEnv = {
  HATCH_SPACE_PRIVILEGED_SOCKET: process.env.HATCH_SPACE_PRIVILEGED_SOCKET,
  HATCH_SPACE_SLUG: process.env.HATCH_SPACE_SLUG,
};

afterEach(async () => {
  process.env.HATCH_SPACE_PRIVILEGED_SOCKET = originalEnv.HATCH_SPACE_PRIVILEGED_SOCKET;
  process.env.HATCH_SPACE_SLUG = originalEnv.HATCH_SPACE_SLUG;
  while (servers.length > 0) {
    const server = servers.pop();
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) await rm(dir, { force: true, recursive: true });
  }
});

function encodeFrame(value: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(value), "utf8");
  const frame = Buffer.allocUnsafe(4 + body.length);
  frame.writeUInt32BE(body.length, 0);
  body.copy(frame, 4);
  return frame;
}

/** A daemon stand-in that records each request and answers with `respond`. */
async function daemon(respond: (request: unknown) => unknown): Promise<unknown[]> {
  const received: unknown[] = [];
  const dir = await mkdtemp(join(tmpdir(), "hatch-saved-products-"));
  tempDirs.push(dir);
  const socketPath = join(dir, "privileged.sock");
  const server = createServer((socket: Socket) => {
    const chunks: Buffer[] = [];
    socket.on("data", (chunk) => {
      chunks.push(Buffer.from(chunk));
      const buffer = Buffer.concat(chunks);
      if (buffer.length < 4 || buffer.length - 4 < buffer.readUInt32BE(0)) return;
      const request = JSON.parse(buffer.subarray(4, 4 + buffer.readUInt32BE(0)).toString("utf8"));
      received.push(request);
      socket.end(encodeFrame(respond(request)));
    });
  });
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => {
      server.off("error", reject);
      resolve();
    });
  });
  process.env.HATCH_SPACE_PRIVILEGED_SOCKET = socketPath;
  process.env.HATCH_SPACE_SLUG = "saved-lists";
  return received;
}

type StoredBlob = { bytes: Buffer; contentType: string; etag: string };

/**
 * An in-memory Space blob store whose etag is the bytes' SHA-256, as in the
 * local runtime. Clients built on one store share its photos.
 */
function memoryBlobs(): {
  blobs: BlobClient;
  puts: Map<string, { bytes: Buffer; contentType?: string }>;
  heads: string[];
} {
  const puts = new Map<string, { bytes: Buffer; contentType?: string }>();
  const heads: string[] = [];
  const stored = new Map<string, StoredBlob>();
  const blobs: BlobClient = {
    async put(key: string, data: BlobPutData, options) {
      const bytes = Buffer.from(data as Buffer);
      const entry: { bytes: Buffer; contentType?: string } = { bytes };
      if (options?.contentType !== undefined) entry.contentType = options.contentType;
      puts.set(key, entry);
      stored.set(key, {
        bytes,
        contentType: options?.contentType ?? "application/octet-stream",
        etag: createHash("sha256").update(bytes).digest("hex"),
      });
    },
    async getUrl(key: string) {
      return `./blobs/${key}`;
    },
    async delete(key: string) {
      stored.delete(key);
    },
    async head(key: string) {
      heads.push(key);
      const blob = stored.get(key);
      if (!blob) return null;
      return {
        key,
        contentType: blob.contentType,
        size: blob.bytes.length,
        sizeBytes: blob.bytes.length,
        etag: blob.etag,
        visibility: "private",
        createdAtMs: 1,
        updatedAtMs: 1,
        public: false,
      };
    },
    async list() {
      return [];
    },
  };
  return { blobs, puts, heads };
}

const PHOTO = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const sha256 = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");
const product = (name: string, citation: string) => ({
  type: "catalog",
  citation_id: citation,
  product_id: `p-${citation}`,
  url: `https://example.com/${citation}`,
  name,
  image_url: `https://scontent.fbcdn.net/${citation}.png`,
});
/** A product's photo identity, standing in for the daemon's digest. */
const source = (citation: string) => sha256(`product:${citation}`);
const photoKey = (citation: string) => `saved-products/${source(citation)}.img`;

const ownerViewer: LocalViewer = {
  source: "local",
  authenticated: true,
  spaceSlug: "saved-lists",
  userId: "7",
  ownerUserId: "7",
  isOwner: true,
};

function owner(blobs: BlobClient) {
  return { blobs, actionInvocationId: "invocation-1", actionName: "readLists", viewer: ownerViewer };
}

function listsResult(items: unknown[], images: unknown[]) {
  return {
    ok: true,
    result: {
      kind: "saved_product_lists",
      lists: [{ list: "Kitchen", missing: false, items }],
      images,
    },
  };
}

describe("ctx.tool.saved_product_lists", () => {
  test("omitted and empty names read the daemon's declared lists in declaration order", async () => {
    const received = await daemon(() => ({
      ok: true,
      result: {
        kind: "saved_product_lists",
        lists: [
          {
            list: "Kitchen",
            missing: false,
            items: [{ product: product("Kettle", "c1"), image: photoKey("c1"), image_source: source("c1"), price: "current" }],
          },
          { list: "Garden", missing: true, items: [] },
          { list: "é".repeat(128), missing: false, items: [] },
        ],
        images: [{ key: photoKey("c1"), content_type: "image/png", data_base64: PHOTO.toString("base64") }],
      },
    }));
    const { blobs, puts } = memoryBlobs();
    const ctx = owner(blobs);
    for (const read of [
      () => readSavedProductLists(ctx),
      () => readSavedProductLists(ctx, []),
      () => readSavedProductLists(ctx, undefined),
    ]) {
      const result = await read();
      expect(result.lists.map((list) => list.list)).toEqual(["Kitchen", "Garden", "é".repeat(128)]);
      expect(result.lists[0]!.items[0]!.imageKey).toBe(photoKey("c1"));
      expect(result.lists[1]).toEqual({ list: "Garden", missing: true, items: [] });
    }
    expect(received.map((request) => (request as { lists: unknown }).lists)).toEqual([[], [], []]);
    expect(received.map((request) => (request as { refresh_prices: unknown }).refresh_prices)).toEqual([
      true,
      true,
      true,
    ]);
    expect([...puts.keys()]).toEqual([photoKey("c1")]);
  });

  test("declaration-backed responses remain bounded, unique and validated before blob access", async () => {
    const valid = {
      list: "Kitchen",
      missing: false,
      items: [{ product: product("Kettle", "c1"), image: photoKey("c1"), image_source: source("c1"), price: "current" }],
    };
    const photo = { key: photoKey("c1"), content_type: "image/png", data_base64: PHOTO.toString("base64") };
    const empty = { list: "Garden", missing: false, items: [] };
    const cases: Array<[string, unknown[], unknown[]]> = [
      ["duplicate names", [valid, { ...empty, list: "Kitchen" }], [photo]],
      ["an empty name", [valid, { ...empty, list: "" }], [photo]],
      ["a non-string name", [valid, { ...empty, list: 1 }], [photo]],
      ["a name over 256 UTF-8 bytes", [valid, { ...empty, list: "é".repeat(129) }], [photo]],
      ["more than 20 lists", [valid, ...Array.from({ length: 20 }, (_, index) => ({ ...empty, list: `List ${index}` }))], [photo]],
      ["more than 500 products", [valid, { ...empty, items: Array.from({ length: 500 }, () => ({ product: product("Mug", "c2"), image: null, price: "saved" })) }], [photo]],
      ["a missing list with items", [{ ...valid, missing: true }], [photo]],
      ["an invalid photo source", [{ ...valid, items: [{ ...valid.items[0]!, image: null, image_source: "../../app/data" }] }], []],
      ["an absent photo", [valid], []],
      ["a photo outside the reserved keys", [valid], [{ ...photo, key: "app/data.png" }]],
      ["a photo no item names", [empty], [photo]],
    ];
    for (const [name, lists, images] of cases) {
      await daemon(() => ({ ok: true, result: { kind: "saved_product_lists", lists, images } }));
      const { blobs, puts, heads } = memoryBlobs();
      const error = await readSavedProductLists(owner(blobs)).then(
        () => new Error(`${name} was accepted`),
        (e) => e,
      );
      expect({ name, message: (error as Error).message }).toMatchObject({ name, message: expect.stringContaining("malformed") });
      expect({ name, writes: puts.size, heads }).toEqual({ name, writes: 0, heads: [] });
    }
  });

  test("invalid explicit selections make no daemon request or blob access", async () => {
    const received = await daemon(() => {
      throw new Error("an invalid selection must not reach the daemon");
    });
    const { blobs, puts, heads } = memoryBlobs();
    for (const lists of [
      ["Kitchen", "Kitchen"],
      [""],
      ["é".repeat(129)],
      Array.from({ length: 21 }, (_, index) => `List ${index}`),
    ]) {
      expect(await readSavedProductLists(owner(blobs), lists).catch((error) => error)).toBeInstanceOf(TypeError);
    }
    expect(received).toEqual([]);
    expect(puts.size).toBe(0);
    expect(heads).toEqual([]);
  });

  test("stores the daemon's photos in the Space's blobs and links items to them", async () => {
    const received = await daemon(() => ({
      ok: true,
      result: {
        kind: "saved_product_lists",
        lists: [
          {
            list: "Kitchen",
            missing: false,
            items: [
              {
                product: product("Kettle", "c1"),
                image: photoKey("c1"),
                image_source: source("c1"),
                saved_at: "2026-11-01T00:00:00Z",
                price: "current",
              },
              { product: product("Mug", "c2"), image: null, price: "refreshing" },
            ],
          },
          { list: "Gone", missing: true, items: [] },
        ],
        images: [{ key: photoKey("c1"), content_type: "image/png", data_base64: PHOTO.toString("base64") }],
      },
    }));
    const { blobs, puts } = memoryBlobs();

    const result = await readSavedProductLists(owner(blobs), ["Kitchen", "Gone"]);

    expect(received[0]).toMatchObject({
      kind: "saved_product_lists",
      slug: "saved-lists",
      action_name: "readLists",
      action_invocation_id: "invocation-1",
      lists: ["Kitchen", "Gone"],
      refresh_prices: true,
    });
    expect([...puts.keys()]).toEqual([photoKey("c1")]);
    expect(puts.get(photoKey("c1"))).toEqual({ bytes: PHOTO, contentType: "image/png" });
    const items = result.lists[0]!.items;
    expect(items.map((item) => [item.image, item.imageKey, item.imageVersion, item.savedAt, item.price])).toEqual([
      [`./blobs/${photoKey("c1")}?v=${sha256(PHOTO)}`, photoKey("c1"), sha256(PHOTO), "2026-11-01T00:00:00Z", "current"],
      [null, null, null, null, "refreshing"],
    ]);
    expect(items[1]!.product.name).toBe("Mug");
    expect(result.lists[1]).toEqual({ list: "Gone", missing: true, items: [] });
  });

  test("only the owner's refusal is the typed unavailable error", async () => {
    const { blobs, puts } = memoryBlobs();

    await daemon(() => ({
      ok: false,
      error: "Live saved products are available only to the Space owner",
      error_code: "saved_product_lists_owner_only",
    }));
    const refused = await readSavedProductLists(owner(blobs), ["Kitchen"]).catch((e) => e);
    expect(SavedProductListsUnavailableError.is(refused)).toBe(true);

    await daemon(() => ({ ok: false, error: "saved product read timed out" }));
    const other = await readSavedProductLists(owner(blobs), ["Kitchen"]).catch((e) => e);
    expect(SavedProductListsUnavailableError.is(other)).toBe(false);
    expect((other as Error).message).toBe("saved product read timed out");

    const otherRequests = await daemon(() => {
      throw new Error("only the owner's invocation reaches the daemon");
    });
    const noViewer = { blobs, actionInvocationId: "invocation-1", actionName: "readLists" };
    for (const ctx of [
      noViewer,
      { ...noViewer, viewer: { ...ownerViewer, userId: "8", isOwner: false } },
      {
        ...noViewer,
        viewer: { source: "peer", authenticated: true, spaceSlug: "saved-lists", museId: "m1", role: "use", isOwner: false } as const,
      },
    ]) {
      const refusal = await readSavedProductLists(ctx, ["Kitchen"]).catch((e) => e);
      expect(SavedProductListsUnavailableError.is(refusal)).toBe(true);
    }
    expect(otherRequests).toEqual([]);
    expect(puts.size).toBe(0);
  });

  test("a malformed response writes and looks up nothing in the Space's blobs", async () => {
    const valid = {
      list: "Kitchen",
      missing: false,
      items: [
        { product: product("Kettle", "c1"), image: photoKey("c1"), image_source: source("c1"), price: "current" },
      ],
    };
    const item = valid.items[0]!;
    const photo = { key: photoKey("c1"), content_type: "image/png", data_base64: PHOTO.toString("base64") };
    const withItem = (changes: object) => ({ lists: [{ ...valid, items: [{ ...item, ...changes }] }], images: [photo] });
    const cases: Array<[string, unknown]> = [
      ["a key outside saved-products/", { lists: [valid], images: [{ ...photo, key: "app/data.png" }] }],
      ["an item naming an absent photo", { lists: [valid], images: [] }],
      ["a photo no item names", withItem({ image: null })],
      ["a non-image content type", { lists: [valid], images: [{ ...photo, content_type: "text/html" }] }],
      ["an unknown price state", withItem({ price: "live" })],
      ["lists out of request order", { lists: [{ ...valid, list: "Other" }], images: [photo] }],
      ["a photo key that isn't its source's", withItem({ image_source: source("c2") })],
      ["a photo without a source", withItem({ image_source: null })],
      ["a save time over 128 bytes", withItem({ saved_at: "2".repeat(129) })],
      [
        "a source that isn't a photo identity",
        { lists: [{ ...valid, items: [{ ...item, image: null, image_source: "../../app/data" }] }], images: [] },
      ],
    ];
    for (const [name, body] of cases) {
      await daemon(() => ({ ok: true, result: { kind: "saved_product_lists", ...(body as object) } }));
      const { blobs, puts, heads } = memoryBlobs();
      const error = await readSavedProductLists(owner(blobs), ["Kitchen"]).then(
        () => new Error(`${name} was accepted`),
        (e) => e,
      );
      expect({ name, message: (error as Error).message }).toMatchObject({
        name,
        message: expect.stringContaining("malformed"),
      });
      expect({ name, writes: puts.size, heads }).toEqual({ name, writes: 0, heads: [] });
    }
  });

  test("photos a read leaves out keep those earlier reads stored, so every client converges", async () => {
    const citations = ["c1", "c2", "c3", "c4", "c5"];
    const bytesOf = (citation: string) => Buffer.concat([PHOTO, Buffer.from(citation)]);
    // Each read's photo budget fits four of the five photos, a different four.
    const subsets = [
      ["c1", "c2", "c3", "c4"],
      ["c2", "c3", "c4", "c5"],
      ["c1", "c3", "c4", "c5"],
      ["c1", "c2", "c4", "c5"],
      ["c1", "c2", "c3", "c5"],
    ];
    let read = 0;
    await daemon(() => {
      const carried = subsets[read++ % subsets.length]!;
      return listsResult(
        citations.map((citation) => ({
          product: product(`Item ${citation}`, citation),
          image: carried.includes(citation) ? photoKey(citation) : null,
          image_source: source(citation),
          price: "current",
        })),
        carried.map((citation) => ({
          key: photoKey(citation),
          content_type: "image/jpeg",
          data_base64: bytesOf(citation).toString("base64"),
        })),
      );
    });
    // Two of the owner's open clients on one Space blob store.
    const { blobs, heads } = memoryBlobs();
    const clients = [owner(blobs), { ...owner(blobs), actionInvocationId: "invocation-2" }];
    const photos = async (client: number) =>
      (await readSavedProductLists(clients[client % 2]!, ["Kitchen"])).lists[0]!.items.map((item) => ({
        key: item.imageKey,
        version: item.imageVersion,
        image: item.image,
      }));

    const first = await photos(0);
    expect(first.map((photo) => photo.key)).toEqual([...citations.slice(0, 4).map(photoKey), null]);
    const settled = await photos(1);
    expect(settled).toEqual(
      citations.map((citation) => ({
        key: photoKey(citation),
        version: sha256(bytesOf(citation)),
        image: `./blobs/${photoKey(citation)}?v=${sha256(bytesOf(citation))}`,
      })),
    );
    for (let client = 2; client < 10; client += 1) {
      expect(await photos(client)).toEqual(settled);
    }
    expect(new Set(heads)).toEqual(new Set(citations.map(photoKey)));
  });

  test("a product with no photo source shows no photo and looks nothing up", async () => {
    await daemon(() =>
      listsResult([{ product: product("Kettle", "c1"), image: null, image_source: null, price: "saved" }], []),
    );
    const { blobs, heads } = memoryBlobs();
    await blobs.put(photoKey("c1"), PHOTO, { contentType: "image/png" });

    const result = await readSavedProductLists(owner(blobs), ["Kitchen"]);

    expect(result.lists[0]!.items[0]).toMatchObject({ image: null, imageKey: null, imageVersion: null });
    expect(heads).toEqual([]);
  });
});

describe("mergeSavedProductListsCache", () => {
  const item = (
    citation: string,
    price: string,
    state: SavedProductListItem["price"],
    savedAt: string | null = "2026-11-01T00:00:00Z",
  ): SavedProductListItem => ({
    product: { ...product(`Item ${citation}`, citation), type: "catalog", price, currency: "USD" },
    image: null,
    imageKey: null,
    imageVersion: null,
    savedAt,
    price: state,
  });
  const kitchen = (...items: SavedProductListItem[]): SavedProductLists => ({
    lists: [{ list: "Kitchen", missing: false, items }],
  });
  const prices = (lists: SavedProductLists) =>
    lists.lists[0]!.items.map((entry) => [entry.product.citation_id, entry.product.price, entry.price]);

  test("a price a read couldn't check keeps the last checked one, and the list is next's", () => {
    // Refreshes of c1 alternate between succeeding ($5.00) and falling back
    // to the saved price ($4.00); c2 is removed and c3 added along the way.
    let cache = mergeSavedProductListsCache(null, kitchen(item("c1", "$5.00", "current"), item("c2", "$7.00", "current")));
    const reads = [
      kitchen(item("c1", "$4.00", "saved")),
      kitchen(item("c1", "$5.00", "current"), item("c3", "$2.00", "refreshing")),
      kitchen(item("c1", "$4.00", "refreshing"), item("c3", "$2.00", "refreshing")),
      // Saved again at $4.50: the new saved price replaces the checked one.
      kitchen(item("c1", "$4.50", "saved", "2026-11-05T00:00:00Z"), item("c3", "$2.00", "refreshing")),
      // A product with no save time never reuses a checked price.
      kitchen(item("c1", "$4.00", "saved", null)),
    ];
    const seen = reads.map((read) => prices((cache = mergeSavedProductListsCache(cache, read))));

    const checkedName = kitchen({ ...item("c1", "$5.00", "current"), product: { ...item("c1", "$5.00", "current").product, name: "Electric Kettle" } });
    const fallbackName = kitchen({ ...item("c1", "$4.00", "saved"), product: { ...item("c1", "$4.00", "saved").product, name: "Kettle" } });
    expect(mergeSavedProductListsCache(checkedName, fallbackName).lists[0]!.items[0]!.product.name).toBe("Electric Kettle");
    expect(seen).toEqual([
      [["c1", "$5.00", "cached"]],
      [
        ["c1", "$5.00", "current"],
        ["c3", "$2.00", "refreshing"],
      ],
      [
        ["c1", "$5.00", "cached"],
        ["c3", "$2.00", "refreshing"],
      ],
      [
        ["c1", "$4.50", "saved"],
        ["c3", "$2.00", "refreshing"],
      ],
      [["c1", "$4.00", "saved"]],
    ]);
  });
});

describe("readDeclaredSavedProductLists", () => {
  test("a declaration counts only from a bounded regular space.json, never through a link", async () => {
    const dir = await mkdtemp(join(tmpdir(), "hatch-space-manifest-"));
    tempDirs.push(dir);
    const manifest = join(dir, "space.json");
    const declare = (value: unknown) => writeFile(manifest, JSON.stringify(value));

    await declare({ runtime: "typescript", savedProductLists: ["Kitchen", "Garden"] });
    expect(await readDeclaredSavedProductLists(dir)).toEqual(["Kitchen", "Garden"]);

    for (const invalid of [
      { runtime: "static", savedProductLists: ["Kitchen"] },
      { runtime: "typescript", savedProductLists: ["Kitchen", "Kitchen"] },
      { runtime: "typescript", savedProductLists: ["k".repeat(257)] },
      { runtime: "typescript", savedProductLists: "Kitchen" },
      { runtime: "typescript", savedProductLists: ["Kitchen"], padding: "x".repeat(64 * 1024) },
    ]) {
      await declare(invalid);
      expect(await readDeclaredSavedProductLists(dir)).toBeUndefined();
    }

    await rm(manifest);
    const elsewhere = join(dir, "elsewhere.json");
    await writeFile(elsewhere, JSON.stringify({ runtime: "typescript", savedProductLists: ["Kitchen"] }));
    await symlink(elsewhere, manifest);
    expect(await readDeclaredSavedProductLists(dir)).toBeUndefined();
    expect(await readDeclaredSavedProductLists(join(dir, "missing"))).toBeUndefined();
  });
});
