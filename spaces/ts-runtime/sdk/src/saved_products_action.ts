// `savedProductsAction`: the whole server side of a page of the owner's
// saved products, as one Space action. The owner's read is live; everyone
// else, and every shared or published copy, gets the copy the owner's last
// read saved in the Space's app.db. Both runtimes build it from this file,
// each with its own `Ctx`.

import { sql } from "drizzle-orm";

import {
  SavedProductListsUnavailableError,
  mergeSavedProductListsCache,
  type SavedProductListItem,
  type SavedProductLists,
} from "./saved_product_lists";
import { createDefineAction, z, type PortableCtx, type SpaceDb } from "./server-contract";

const MAX_LISTS = 20;
const MAX_LIST_NAME_BYTES = 256;
const CACHE_TABLE = "hatch_saved_products";
const IMAGE_KEY = /^saved-products\/[0-9a-f]{64}\.img$/;
const IMAGE_CONTENT_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
/** Writers that lose a race re-read; this bounds how often. */
const MAX_COMMIT_ATTEMPTS = 5;

const displayMessage = z.string().refine((message) => message.trim().length > 0);
const savedProductsMessagesSchema = z.object({
  currentPrice: displayMessage,
  lastCheckedPrice: displayMessage,
  savedPrice: displayMessage,
  snapshotNotice: displayMessage,
  unavailableNotice: displayMessage,
  ownerSharedCopyNotice: displayMessage,
});

/** Complete display copy in the Space's authored UI language. */
export type SavedProductsMessages = Readonly<z.infer<typeof savedProductsMessagesSchema>>;

const ENGLISH_MESSAGES: SavedProductsMessages = {
  currentPrice: "Current price",
  lastCheckedPrice: "Last checked price",
  savedPrice: "Saved price",
  snapshotNotice: "These are the saved products from the owner's last visit; prices may have changed since.",
  unavailableNotice: "Saved products aren't available in this copy.",
  ownerSharedCopyNotice: "This is your shared copy. Open the original Space in Muse to see live saved products.",
};

/** The action's request: it takes no arguments. */
export const SAVED_PRODUCTS_REQUEST_SCHEMA = z.object({}).strict();

/** The product card; pass it unchanged to `museShopping` to open its details. */
const PRODUCT_SCHEMA = z
  .object({
    type: z.enum(["catalog", "marketplace", "browser"]),
    url: z.string(),
    name: z.string(),
    image_url: z.string().nullable().optional(),
    citation_id: z.string().optional(),
    product_id: z.string().optional(),
    provider: z.string().optional(),
    retailer_name: z.string().optional(),
    brand: z.string().optional(),
    price: z.string().optional(),
    sale_price: z.string().optional(),
    currency: z.string().optional(),
  })
  .catchall(z.json());

/** The action's response, the shape the page renders. */
export const SAVED_PRODUCTS_RESPONSE_SCHEMA = z.object({
  lists: z.array(
    z.object({
      /** The list's name. */
      list: z.string(),
      /** True when the owner has no list by this name. */
      missing: z.boolean(),
      /** The list's products in its saved order, newest first. */
      items: z.array(
        z.object({
          /** The product card; pass it unchanged to `museShopping` to open its details. */
          product: PRODUCT_SCHEMA,
          /** Own-origin URL of the product's photo, or null for none. Never render `product.image_url`. */
          image: z.string().nullable(),
          /** What the product's price is, ready to show beside it; null when it has none. */
          priceLabel: z.string().nullable(),
        }),
      ),
    }),
  ),
  /** When the saved copy being shown was read (ISO 8601); null for the owner's live read. */
  snapshotAt: z.string().nullable(),
  /** A note to show above the lists, or null for the owner's live read. */
  notice: z.string().nullable(),
});

export type SavedProducts = z.infer<typeof SAVED_PRODUCTS_RESPONSE_SCHEMA>;

export interface SavedProductsActionOptions {
  /**
   * Only these of the lists `space.json` declares, in this order, for one
   * section of a page. Omit for every declared list.
   */
  readonly lists?: readonly string[];
  /** Use "en" for an English Space, or supply every message in the Space's language. */
  readonly messages: "en" | SavedProductsMessages;
}

/** What the action needs from either runtime's `Ctx`. */
export interface SavedProductsActionCtx extends PortableCtx {
  readonly tool: {
    saved_product_lists(lists?: readonly string[]): Promise<SavedProductLists>;
  };
  invalidateQueries(): void;
}

/** Builds `savedProductsAction` for one runtime's `Ctx`. */
export function savedProductsActionFor<TCtx extends SavedProductsActionCtx>() {
  const defineAction = createDefineAction<TCtx>();
  return function savedProductsAction(options: SavedProductsActionOptions) {
    const configured = options?.messages;
    const messages = configured === "en" ? ENGLISH_MESSAGES : authoredMessages(configured);
    const selection = selectionOf(options);
    return defineAction({
      request: SAVED_PRODUCTS_REQUEST_SCHEMA,
      response: SAVED_PRODUCTS_RESPONSE_SCHEMA,
      description:
        "Returns the owner's saved product lists for this page: live for the owner, and the owner's last saved copy for anyone else.",
      handler: (ctx) => readSavedProducts(ctx, selection, messages),
    });
  };
}

function authoredMessages(configured: unknown): SavedProductsMessages {
  const result = savedProductsMessagesSchema.safeParse(configured);
  if (!result.success) {
    throw new TypeError(
      'savedProductsAction requires messages: "en" for an English Space or all six display messages in the Space\'s language',
    );
  }
  // Zod copies the strings so the declaration cannot change between invocations.
  return result.data;
}

type Selection = { key: string; lists: readonly string[] };

function selectionOf(options: SavedProductsActionOptions): Selection {
  if (options.lists === undefined) return { key: "declared", lists: [] };
  const lists = [...options.lists];
  if (lists.length === 0 || lists.length > MAX_LISTS) {
    throw new TypeError("savedProductsAction takes 1 to 20 list names");
  }
  const encoder = new TextEncoder();
  for (const name of lists) {
    if (typeof name !== "string" || name.length === 0 || encoder.encode(name).length > MAX_LIST_NAME_BYTES) {
      throw new TypeError("savedProductsAction takes list names of 1 to 256 UTF-8 bytes");
    }
  }
  if (new Set(lists).size !== lists.length) {
    throw new TypeError("savedProductsAction takes unique list names");
  }
  return { key: `lists:${JSON.stringify(lists)}`, lists };
}

async function readSavedProducts(
  ctx: SavedProductsActionCtx,
  selection: Selection,
  messages: SavedProductsMessages,
): Promise<SavedProducts> {
  const startedMs = Date.now();
  let live: SavedProductLists;
  try {
    live = await ctx.tool.saved_product_lists(selection.lists);
  } catch (error) {
    if (!SavedProductListsUnavailableError.is(error)) throw error;
    return savedCopy(ctx, selection, messages);
  }
  const lists = await commitLiveRead(ctx, selection, live, startedMs);
  return {
    lists: await publicLists(ctx, lists, { live: true, messages }),
    snapshotAt: null,
    notice: null,
  };
}

/**
 * What a viewer who can't read live sees: the owner's last saved read, never a
 * live one, cut to the lists `space.json` declares now. A list the owner has
 * stopped declaring disappears from every copy at once, before the owner's
 * next read rewrites the row; a section naming such a list shows nothing.
 */
async function savedCopy(
  ctx: SavedProductsActionCtx,
  selection: Selection,
  messages: SavedProductsMessages,
): Promise<SavedProducts> {
  const ownerCopy = ctx.viewer?.source === "cloudflare" && ctx.viewer.isOwner === true;
  const unavailable = { lists: [], snapshotAt: null, notice: ownerCopy ? messages.ownerSharedCopyNotice : messages.unavailableNotice };
  const declared = ctx.savedProductLists;
  const names = selection.lists.length === 0 ? declared : selection.lists;
  if (declared === undefined || names === undefined || names.some((name) => !declared.includes(name))) {
    return unavailable;
  }
  const db = ctx.db();
  const row = (await cacheTableExists(db)) ? await readRow(db, selection) : null;
  if (row === null) return unavailable;
  const saved = new Map(row.lists.lists.map((list) => [list.list, list]));
  const lists = names.flatMap((name) => saved.get(name) ?? []);
  if (lists.length === 0) return unavailable;
  return {
    lists: await publicLists(ctx, { lists }, { live: false, messages }),
    snapshotAt: row.readAt,
    notice: ownerCopy ? messages.ownerSharedCopyNotice : messages.snapshotNotice,
  };
}

type CacheRow = {
  revision: number;
  startedMs: number;
  readAt: string;
  fingerprint: string;
  lists: SavedProductLists;
};

/**
 * Saves the owner's read and returns the lists to show. Each write is a
 * compare-and-swap on the row's revision: a writer that loses re-reads, and
 * when the winner's read started later, shows the winner's lists instead of
 * writing older ones over them. Open pages are told to refetch only after a
 * write that changed what they show.
 */
async function commitLiveRead(
  ctx: SavedProductsActionCtx,
  selection: Selection,
  live: SavedProductLists,
  startedMs: number,
): Promise<SavedProductLists> {
  const db = ctx.db();
  await db.run(
    sql`CREATE TABLE IF NOT EXISTS hatch_saved_products (
      selection TEXT PRIMARY KEY NOT NULL,
      revision INTEGER NOT NULL,
      started_ms INTEGER NOT NULL,
      read_at TEXT NOT NULL,
      fingerprint TEXT NOT NULL,
      lists TEXT NOT NULL
    )`,
  );
  const readAt = new Date().toISOString();
  const fresh = withoutPhotoUrls(live);
  for (let attempt = 0; attempt < MAX_COMMIT_ATTEMPTS; attempt += 1) {
    const row = await readRow(db, selection);
    if (row !== null && row.startedMs > startedMs) return row.lists;
    const merged = mergeSavedProductListsCache(row?.lists, fresh);
    const fingerprint = await fingerprintOf(merged);
    const body = JSON.stringify(merged);
    const committed =
      row === null
        ? await db.all(
            sql`INSERT INTO hatch_saved_products (selection, revision, started_ms, read_at, fingerprint, lists)
              VALUES (${selection.key}, 1, ${startedMs}, ${readAt}, ${fingerprint}, ${body})
              ON CONFLICT(selection) DO NOTHING RETURNING revision`,
          )
        : await db.all(
            sql`UPDATE hatch_saved_products
              SET revision = revision + 1, started_ms = ${startedMs}, read_at = ${readAt},
                fingerprint = ${fingerprint}, lists = ${body}
              WHERE selection = ${selection.key} AND revision = ${row.revision} RETURNING revision`,
          );
    if (committed.length === 0) continue;
    if (row?.fingerprint !== fingerprint) ctx.invalidateQueries();
    return merged;
  }
  throw new Error("the saved products cache kept changing during this read; try again");
}

async function cacheTableExists(db: SpaceDb): Promise<boolean> {
  const rows = await db.all(
    sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ${CACHE_TABLE}`,
  );
  return rows.length > 0;
}

const STORED_ITEM = z.object({
  product: PRODUCT_SCHEMA,
  image: z.null(),
  imageKey: z.string().regex(IMAGE_KEY).nullable(),
  imageVersion: z.string().min(1).nullable(),
  savedAt: z.string().nullable(),
  price: z.enum(["current", "saved", "refreshing", "cached"]),
});
const STORED_LISTS = z.object({
  lists: z.array(z.object({ list: z.string(), missing: z.boolean(), items: z.array(STORED_ITEM) })),
});
const STORED_ROW = z.object({
  revision: z.number().int(),
  started_ms: z.number().int(),
  read_at: z.string(),
  fingerprint: z.string(),
  lists: z.string(),
});

async function readRow(db: SpaceDb, selection: Selection): Promise<CacheRow | null> {
  const rows = await db.all(
    sql`SELECT revision, started_ms, read_at, fingerprint, lists FROM hatch_saved_products
      WHERE selection = ${selection.key}`,
  );
  if (rows.length === 0) return null;
  const row = STORED_ROW.safeParse(rows[0]);
  let lists: unknown;
  try {
    lists = row.success ? JSON.parse(row.data.lists) : undefined;
  } catch {
    lists = undefined;
  }
  const parsed = STORED_LISTS.safeParse(lists);
  if (!row.success || !parsed.success) {
    throw new Error("the saved products cache in this Space's database is unreadable");
  }
  return {
    revision: row.data.revision,
    startedMs: row.data.started_ms,
    readAt: row.data.read_at,
    fingerprint: row.data.fingerprint,
    lists: parsed.data as SavedProductLists,
  };
}

/** The cache keeps photo keys and versions; URLs are minted when shown. */
function withoutPhotoUrls(lists: SavedProductLists): SavedProductLists {
  return {
    lists: lists.lists.map((list) => ({
      ...list,
      items: list.items.map((item) => ({ ...item, image: null })),
    })),
  };
}

/**
 * What a page shows, so a read that changes only when it was read, the
 * freshness of an unchanged price, or the catalog's expiring photo link
 * changes nothing.
 */
async function fingerprintOf(lists: SavedProductLists): Promise<string> {
  const shown = lists.lists.map((list) => ({
    list: list.list,
    missing: list.missing,
    items: list.items.map((item) => {
      const { image_url: _expiring, ...product } = item.product;
      return {
        product,
        imageKey: item.imageKey,
        imageVersion: item.imageVersion,
        savedAt: item.savedAt,
        price: item.price === "current" || item.price === "cached" ? "checked" : "saved",
      };
    }),
  }));
  const bytes = new TextEncoder().encode(canonicalJson(shown));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, field]) => field !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([key, field]) => `${JSON.stringify(key)}:${canonicalJson(field)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

async function publicLists(
  ctx: SavedProductsActionCtx,
  lists: SavedProductLists,
  { live, messages }: { live: boolean; messages: SavedProductsMessages },
): Promise<SavedProducts["lists"]> {
  const photos = new Map<string, Promise<string | null>>();
  const photo = (item: SavedProductListItem): Promise<string | null> => {
    const { imageKey: key, imageVersion: version } = item;
    if (key === null || version === null) return Promise.resolve(null);
    const cacheKey = `${key}\n${version}`;
    let url = photos.get(cacheKey);
    if (url === undefined) {
      url = live ? versionedUrl(ctx, key, version) : storedPhotoUrl(ctx, key);
      photos.set(cacheKey, url);
    }
    return url;
  };
  return Promise.all(
    lists.lists.map(async (list) => ({
      list: list.list,
      missing: list.missing,
      items: await Promise.all(
        list.items.map(async (item) => ({
          product: item.product as z.infer<typeof PRODUCT_SCHEMA>,
          image: await photo(item),
          priceLabel: priceLabel(item, live, messages),
        })),
      ),
    })),
  );
}

/** A saved copy shows a photo only while the Space still holds one at its key. */
async function storedPhotoUrl(ctx: SavedProductsActionCtx, key: string): Promise<string | null> {
  const stored = await ctx.blobs.head(key);
  if (
    stored === null ||
    stored.key !== key ||
    !IMAGE_CONTENT_TYPES.has(stored.contentType) ||
    stored.size <= 0 ||
    stored.etag.length === 0
  ) {
    return null;
  }
  return versionedUrl(ctx, key, stored.etag);
}

async function versionedUrl(ctx: SavedProductsActionCtx, key: string, version: string): Promise<string> {
  const url = await ctx.blobs.getUrl(key);
  const hash = url.indexOf("#");
  const [base, fragment] = hash === -1 ? [url, ""] : [url.slice(0, hash), url.slice(hash)];
  return `${base}${base.includes("?") ? "&" : "?"}v=${encodeURIComponent(version)}${fragment}`;
}

/** A saved copy never calls a price current: it was current when the owner last looked. */
function priceLabel(
  item: SavedProductListItem,
  live: boolean,
  messages: SavedProductsMessages,
): string | null {
  const { price, sale_price: sale } = item.product;
  if (!price && !sale) return null;
  switch (item.price) {
    case "current":
      return live ? messages.currentPrice : messages.lastCheckedPrice;
    case "cached":
      return messages.lastCheckedPrice;
    case "saved":
    case "refreshing":
      return messages.savedPrice;
  }
}
