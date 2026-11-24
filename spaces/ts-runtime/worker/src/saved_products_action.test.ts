import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Client } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { sql } from "drizzle-orm";
import {
  SAVED_PRODUCTS_REQUEST_SCHEMA,
  SavedProductListsUnavailableError,
  savedProductsAction,
  type ActionsModule,
  type BlobClient,
  type BlobPutData,
  type Ctx,
  type SavedProductListItem,
  type SavedProductLists,
  type SpaceDb,
} from "@hatch/space-sdk";

import { openReadOnlyClient, openSpaceDb } from "./db";
import { readOnlyClient } from "./read_only";

// Pages export it exactly like this.
const Actions = {
  getProducts: savedProductsAction({ messages: "en" }),
  getKitchen: savedProductsAction({ messages: "en", lists: ["Kitchen"] }),
} satisfies ActionsModule;

const tempDirs: string[] = [];
const clients: Client[] = [];
const databases: Array<{ close(): Promise<void> }> = [];

/** Read start times, set per test so which read started first never depends on timing. */
let clock: ReturnType<typeof spyOn<DateConstructor, "now">> | undefined;
function startAt(ms: number): void {
  clock ??= spyOn(Date, "now");
  clock.mockReturnValue(ms);
}

afterEach(async () => {
  clock?.mockRestore();
  clock = undefined;
  while (clients.length > 0) clients.pop()?.close();
  while (databases.length > 0) await databases.pop()?.close();
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) await rm(dir, { force: true, recursive: true });
  }
});

async function appDb(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "hatch-saved-products-action-"));
  tempDirs.push(dir);
  return join(dir, "app.db");
}

/** An owner's connection, exactly as the worker opens it. */
async function writer(path: string): Promise<SpaceDb> {
  const database = await openSpaceDb(path);
  databases.push(database);
  return database.accessor();
}

/** A `view` grantee's connection, exactly as the worker opens it. */
async function reader(path: string): Promise<SpaceDb> {
  const client = await openReadOnlyClient(path);
  clients.push(client);
  return drizzle(readOnlyClient(client, () => openReadOnlyClient(path))) as unknown as SpaceDb;
}

const sha256 = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");

/** One Space's blob store, shared by every context built on it. */
function spaceBlobs(): BlobClient & { stored: Map<string, { bytes: Buffer; contentType: string }> } {
  const stored = new Map<string, { bytes: Buffer; contentType: string }>();
  return {
    stored,
    async put(key: string, data: BlobPutData, options) {
      stored.set(key, { bytes: Buffer.from(data as Buffer), contentType: options?.contentType ?? "" });
    },
    async getUrl(key: string) {
      return `./blobs/${key}`;
    },
    async delete(key: string) {
      stored.delete(key);
    },
    async head(key: string) {
      const blob = stored.get(key);
      if (!blob) return null;
      return {
        key,
        contentType: blob.contentType,
        size: blob.bytes.length,
        sizeBytes: blob.bytes.length,
        etag: sha256(blob.bytes),
        visibility: "private" as const,
        createdAtMs: 1,
        updatedAtMs: 1,
        public: false,
      };
    },
    async list() {
      return [];
    },
  };
}

type Live = SavedProductLists | Error | (() => Promise<SavedProductLists>);

function context(
  db: SpaceDb,
  blobs: BlobClient,
  reads: Live[],
  /** What `space.json` declares; null for a Space that declares nothing. */
  savedProductLists: readonly string[] | null = ["Kitchen"],
): { ctx: Ctx; invalidations: () => number } {
  let invalidations = 0;
  const ctx = {
    ...(savedProductLists !== null ? { savedProductLists } : {}),
    slug: "saved-lists",
    invocationId: "invocation",
    spaceDir: "",
    db: () => db,
    blobs,
    viewer: {
      source: "local",
      authenticated: true,
      spaceSlug: "saved-lists",
      userId: "owner",
      ownerUserId: "owner",
      isOwner: true,
    },
    tool: {
      async saved_product_lists() {
        const next = reads.shift();
        if (next === undefined) throw new Error("no live read scripted");
        if (next instanceof Error) throw next;
        return typeof next === "function" ? next() : next;
      },
    },
    invalidateQueries() {
      invalidations += 1;
    },
  };
  return { ctx: ctx as unknown as Ctx, invalidations: () => invalidations };
}

const PHOTO = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const photoKey = (citation: string) => `saved-products/${sha256(`product:${citation}`)}.img`;

function item(
  citation: string,
  price: string,
  state: SavedProductListItem["price"],
  options: { savedAt?: string; photo?: boolean; imageUrl?: string } = {},
): SavedProductListItem {
  return {
    product: {
      type: "catalog",
      citation_id: citation,
      product_id: `p-${citation}`,
      url: `https://example.com/${citation}`,
      name: `Item ${citation}`,
      price,
      currency: "USD",
      image_url: options.imageUrl ?? `https://scontent.fbcdn.net/${citation}.png?signed=1`,
    },
    image: options.photo ? `./blobs/${photoKey(citation)}?v=${sha256(PHOTO)}` : null,
    imageKey: options.photo ? photoKey(citation) : null,
    imageVersion: options.photo ? sha256(PHOTO) : null,
    savedAt: options.savedAt ?? "2026-11-01T00:00:00Z",
    price: state,
  };
}

const kitchen = (...items: SavedProductListItem[]): SavedProductLists => ({
  lists: [{ list: "Kitchen", missing: false, items }],
});

const unavailable = () => new SavedProductListsUnavailableError();

async function read(ctx: Ctx, action = Actions.getProducts) {
  return action.handler(ctx, {});
}

const shown = (response: Awaited<ReturnType<typeof read>>) =>
  response.lists.map((list) => [
    list.list,
    list.items.map((entry) => [entry.product.citation_id, entry.product.price, entry.priceLabel, entry.image]),
  ]);

async function cacheTables(path: string): Promise<unknown[]> {
  return (await writer(path)).all(sql`SELECT name FROM sqlite_master WHERE name = 'hatch_saved_products'`);
}

describe("savedProductsAction", () => {
  test("the owner's reads are kept, and open pages refetch only when what they show changes", async () => {
    const path = await appDb();
    const blobs = spaceBlobs();
    await blobs.put(photoKey("c1"), PHOTO, { contentType: "image/png" });
    const photo = `./blobs/${photoKey("c1")}?v=${sha256(PHOTO)}`;
    const { ctx, invalidations } = context(await writer(path), blobs, [
      kitchen(item("c1", "$5.00", "current", { photo: true }), item("c2", "$7.00", "saved")),
      // The refresh failed and the catalog signed a new photo link: nothing a page shows changed.
      kitchen(
        item("c1", "$4.00", "saved", { photo: true, imageUrl: "https://scontent.fbcdn.net/c1.png?signed=2" }),
        item("c2", "$7.00", "saved"),
      ),
      kitchen(item("c1", "$4.00", "refreshing", { photo: true }), item("c3", "$2.00", "saved")),
      kitchen(item("c1", "$4.50", "saved", { photo: true, savedAt: "2026-11-05T00:00:00Z" }), item("c3", "$2.00", "saved")),
    ]);

    const first = await read(ctx);
    expect({ shown: shown(first), snapshotAt: first.snapshotAt, notice: first.notice }).toEqual({
      shown: [["Kitchen", [["c1", "$5.00", "Current price", photo], ["c2", "$7.00", "Saved price", null]]]],
      snapshotAt: null,
      notice: null,
    });
    expect(invalidations()).toBe(1);

    expect(shown(await read(ctx))).toEqual([
      ["Kitchen", [["c1", "$5.00", "Last checked price", photo], ["c2", "$7.00", "Saved price", null]]],
    ]);
    expect(invalidations()).toBe(1);

    // c2 left the list and c3 joined it.
    expect(shown(await read(ctx))).toEqual([
      ["Kitchen", [["c1", "$5.00", "Last checked price", photo], ["c3", "$2.00", "Saved price", null]]],
    ]);
    expect(invalidations()).toBe(2);

    // Saved again at another price: the new saved price replaces the checked one.
    expect(shown(await read(ctx))).toEqual([
      ["Kitchen", [["c1", "$4.50", "Saved price", photo], ["c3", "$2.00", "Saved price", null]]],
    ]);
    expect(invalidations()).toBe(3);
  });

  test("anyone who can't read live gets the owner's saved copy, and never writes", async () => {
    const path = await appDb();
    const blobs = spaceBlobs();
    // The build migrates app.db, in WAL mode, before any viewer connects.
    const ownerDb = await writer(path);
    await ownerDb.run(sql`CREATE TABLE notes (id INTEGER PRIMARY KEY)`);
    const before = context(await reader(path), blobs, [unavailable(), unavailable(), unavailable(), unavailable()]);

    expect(await read(before.ctx)).toEqual({
      lists: [],
      snapshotAt: null,
      notice: "Saved products aren't available in this copy.",
    });
    expect(await cacheTables(path)).toEqual([]);

    await blobs.put(photoKey("c1"), PHOTO, { contentType: "image/png" });
    await blobs.put(photoKey("c2"), PHOTO, { contentType: "image/png" });
    const owner = context(ownerDb, blobs, [
      kitchen(item("c1", "$5.00", "current", { photo: true }), item("c2", "$7.00", "saved", { photo: true })),
    ]);
    await read(owner.ctx);
    const [row] = await (await writer(path)).all<{ read_at: string }>(sql`SELECT read_at FROM hatch_saved_products`);

    blobs.stored.delete(photoKey("c2"));
    const viewer = before;
    const copy = await read(viewer.ctx);
    expect({ shown: shown(copy), snapshotAt: copy.snapshotAt, notice: copy.notice }).toEqual({
      // A saved copy never calls a price current, and shows no photo the Space no longer holds.
      shown: [
        [
          "Kitchen",
          [
            ["c1", "$5.00", "Last checked price", `./blobs/${photoKey("c1")}?v=${sha256(PHOTO)}`],
            ["c2", "$7.00", "Saved price", null],
          ],
        ],
      ],
      snapshotAt: row!.read_at,
      notice: "These are the saved products from the owner's last visit; prices may have changed since.",
    });
    // The same long-lived view-only connection sees the owner's next commit.
    const update = context(ownerDb, blobs, [kitchen(item("c1", "$6.00", "current", { photo: true }))]);
    await read(update.ctx);
    expect(shown(await read(viewer.ctx))).toEqual([
      ["Kitchen", [["c1", "$6.00", "Last checked price", `./blobs/${photoKey("c1")}?v=${sha256(PHOTO)}`]]],
    ]);
    // A section's selection keeps a copy of its own.
    expect((await read(viewer.ctx, Actions.getKitchen)).lists).toEqual([]);
    expect([before.invalidations(), viewer.invalidations()]).toEqual([0, 0]);
  });

  test("a localized action keeps its authored copy on live reads and read-only snapshots", async () => {
    const path = await appDb();
    const blobs = spaceBlobs();
    const ownerDb = await writer(path);
    await ownerDb.run(sql`CREATE TABLE notes (id INTEGER PRIMARY KEY)`);
    const messages = {
      currentPrice: "Prix actuel",
      lastCheckedPrice: "Dernier prix vérifié",
      savedPrice: "Prix enregistré",
      snapshotNotice: "Voici la copie de la dernière visite du propriétaire. Les prix ont pu changer.",
      unavailableNotice: "Les produits enregistrés ne sont pas disponibles dans cette copie.",
      ownerSharedCopyNotice: "Ceci est votre copie partagée. Ouvrez l’Espace d’origine dans Muse pour voir vos produits enregistrés en direct.",
    };
    const action = savedProductsAction({ messages });
    // Mutating the authoring object does not change the declared action.
    messages.lastCheckedPrice = "Do not render this";
    const viewer = context(await reader(path), blobs, [unavailable(), unavailable()]);
    const publicOwner = context(await reader(path), blobs, [unavailable(), unavailable()]);
    const publicOwnerCtx: Ctx = {
      ...publicOwner.ctx,
      viewer: {
        source: "cloudflare", authenticated: true, shareId: "share-1", spaceSlug: "saved-lists",
        isOwner: true, tokenExpiresAt: 60_000, tokenId: "token-1",
      },
    };
    expect(await read(publicOwnerCtx, action)).toEqual({
      lists: [], snapshotAt: null, notice: messages.ownerSharedCopyNotice,
    });
    expect(await read(viewer.ctx, action)).toEqual({
      lists: [],
      snapshotAt: null,
      notice: messages.unavailableNotice,
    });
    expect(await cacheTables(path)).toEqual([]);

    const owner = context(ownerDb, blobs, [
      kitchen(item("c1", "5,00 €", "current"), item("c2", "7,00 €", "saved")),
    ]);
    const live = await read(owner.ctx, action);
    expect(live.notice).toBeNull();
    expect(shown(live)).toEqual([
      ["Kitchen", [["c1", "5,00 €", "Prix actuel", null], ["c2", "7,00 €", "Prix enregistré", null]]],
    ]);

    const copy = await read(viewer.ctx, action);
    expect(copy.notice).toBe(messages.snapshotNotice);
    expect(copy.snapshotAt).not.toBeNull();
    expect(shown(copy)).toEqual([
      ["Kitchen", [["c1", "5,00 €", "Dernier prix vérifié", null], ["c2", "7,00 €", "Prix enregistré", null]]],
    ]);
    const ownerCopy = await read(publicOwnerCtx, action);
    expect(ownerCopy.lists).toEqual(copy.lists);
    expect(ownerCopy.snapshotAt).toBe(copy.snapshotAt);
    expect(ownerCopy.notice).toBe(messages.ownerSharedCopyNotice);
    expect([viewer.invalidations(), publicOwner.invalidations()]).toEqual([0, 0]);
    expect(await ownerDb.all(sql`SELECT revision FROM hatch_saved_products`)).toEqual([{ revision: 1 }]);
  });

  test("a saved copy shows only the lists space.json declares now", async () => {
    const path = await appDb();
    const blobs = spaceBlobs();
    const ownerDb = await writer(path);
    await ownerDb.run(sql`CREATE TABLE notes (id INTEGER PRIMARY KEY)`);
    const garden = { list: "Garden", missing: false, items: [item("g1", "$3.00", "saved")] };
    const owner = context(
      ownerDb,
      blobs,
      [{ lists: [...kitchen(item("c1", "$5.00", "current")).lists, garden] }],
      ["Kitchen", "Garden"],
    );
    await read(owner.ctx);

    // One view-only connection; each invocation reads the declaration anew.
    const viewerDb = await reader(path);
    const asDeclared = (declared: readonly string[] | null, action = Actions.getProducts) =>
      read(context(viewerDb, blobs, [unavailable()], declared).ctx, action);
    expect((await asDeclared(["Garden", "Kitchen"])).lists.map((list) => list.list)).toEqual(["Garden", "Kitchen"]);
    // The owner stopped declaring Garden: no copy shows it, before the owner reads again.
    expect(shown(await asDeclared(["Kitchen"]))).toEqual([["Kitchen", [["c1", "$5.00", "Last checked price", null]]]]);
    const unavailableCopy = { lists: [], snapshotAt: null, notice: "Saved products aren't available in this copy." };
    // A section naming a list the Space no longer declares shows nothing.
    expect(await asDeclared(["Garden"], Actions.getKitchen)).toEqual(unavailableCopy);
    expect(await asDeclared(null)).toEqual(unavailableCopy);
    const [row] = await ownerDb.all<{ revision: number }>(sql`SELECT revision FROM hatch_saved_products`);
    expect(row!.revision).toBe(1);
  });

  test("a writer that loses the race shows the newer read instead of writing an older one", async () => {
    const path = await appDb();
    const blobs = spaceBlobs();
    let releaseOlder!: () => void;
    const olderRead = new Promise<void>((resolve) => {
      releaseOlder = resolve;
    });
    const older = context(await writer(path), blobs, [
      async () => {
        await olderRead;
        return kitchen(item("c1", "$5.00", "current"), item("c2", "$7.00", "saved"));
      },
    ]);
    const newer = context(await writer(path), blobs, [kitchen(item("c1", "$6.00", "current"))]);

    startAt(1_000);
    const olderResponse = read(older.ctx);
    startAt(2_000);
    const newerShown = shown(await read(newer.ctx));
    releaseOlder();

    expect(shown(await olderResponse)).toEqual(newerShown);
    expect([older.invalidations(), newer.invalidations()]).toEqual([0, 1]);
    const owner = context(await writer(path), blobs, [unavailable()]);
    expect(shown(await read(owner.ctx))).toEqual([
      ["Kitchen", [["c1", "$6.00", "Last checked price", null]]],
    ]);
  });

  test("a write that loses its compare-and-swap rereads and merges before it commits", async () => {
    const path = await appDb();
    const blobs = spaceBlobs();
    let releaseEarlier!: () => void;
    const earlierRead = new Promise<void>((resolve) => {
      releaseEarlier = resolve;
    });
    const earlier = context(await writer(path), blobs, [
      async () => {
        await earlierRead;
        return kitchen(item("c1", "$6.00", "current"));
      },
    ]);
    startAt(1_000);
    const earlierResponse = read(earlier.ctx);
    startAt(2_000);
    // The later read's insert runs only after the earlier read has committed
    // its own row, so the insert finds that row and the later read rereads it.
    const base = await writer(path);
    let inserts = 0;
    const racing = {
      run: (query: never) => base.run(query),
      all: async (query: never) => {
        if (/INSERT INTO hatch_saved_products/.test(JSON.stringify(query)) && inserts++ === 0) {
          releaseEarlier();
          await earlierResponse;
        }
        return base.all(query);
      },
    } as unknown as SpaceDb;
    const later = context(racing, blobs, [kitchen(item("c1", "$4.00", "saved"), item("c3", "$2.00", "saved"))]);

    expect(shown(await read(later.ctx))).toEqual([
      ["Kitchen", [["c1", "$6.00", "Last checked price", null], ["c3", "$2.00", "Saved price", null]]],
    ]);
    expect([earlier.invalidations(), later.invalidations()]).toEqual([1, 1]);
    const [row] = await (await writer(path)).all<{ revision: number }>(sql`SELECT revision FROM hatch_saved_products`);
    expect(row!.revision).toBe(2);
  });

  test("a broken saved copy or database is an error, never an empty page", async () => {
    const path = await appDb();
    const blobs = spaceBlobs();
    const owner = context(await writer(path), blobs, [kitchen(item("c1", "$5.00", "current")), kitchen(item("c1", "$5.00", "current"))]);
    await read(owner.ctx);
    await (await writer(path)).run(sql`UPDATE hatch_saved_products SET lists = '{"lists": "not lists"}'`);

    const viewer = context(await reader(path), blobs, [unavailable()]);
    await expect(read(viewer.ctx)).rejects.toThrow("unreadable");
    await expect(read(owner.ctx)).rejects.toThrow("unreadable");

    const broken = { all: async () => Promise.reject(new Error("disk I/O error")) } as unknown as SpaceDb;
    await expect(read(context(broken, blobs, [unavailable()]).ctx)).rejects.toThrow("disk I/O error");
  });

  test("a failed live read throws and writes nothing", async () => {
    const path = await appDb();
    const failed = context(await writer(path), spaceBlobs(), [new Error("saved product read timed out")]);
    await expect(read(failed.ctx)).rejects.toThrow("saved product read timed out");
    expect(await cacheTables(path)).toEqual([]);
  });

  test("a section names only valid lists, and the action takes no arguments", () => {
    for (const lists of [[], ["Kitchen", "Kitchen"], ["k".repeat(257)], Array.from({ length: 21 }, (_, i) => `${i}`)]) {
      expect(() => savedProductsAction({ messages: "en", lists })).toThrow(TypeError);
    }
    expect(SAVED_PRODUCTS_REQUEST_SCHEMA.safeParse({ lists: ["Kitchen"] }).success).toBe(false);
  });
});
