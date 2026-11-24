// `ctx.tool.saved_product_lists` in the VM worker. The daemon reads the
// owner's lists over the Space privileged socket (which binds the request to
// this worker's Space) and returns validated product cards plus photo bytes;
// the photos land in the Space's own `ctx.blobs`, like `generate_media`, so a
// page renders own-origin images and never a remote catalog link.
//
// Each product with a photo has a stable `image_source`, and its photo always
// lives at `saved-products/<image_source>.img`. A read's photo budget may
// leave some photos out (`image: null` with a source); those items keep the
// photo an earlier read stored, so the set of photos a page shows converges
// instead of changing with whichever subset the latest read carried.

import { createHash, randomUUID } from "node:crypto";
import { constants, promises as fs } from "node:fs";
import { join } from "node:path";

import type {
  BlobClient,
  BlobMetadata,
  LocalViewer,
  PeerViewer,
  SavedProductList,
  SavedProductListItem,
  SavedProductLists,
  SavedProductPrice,
  SavedProductRecord,
} from "@hatch/space-sdk";

import {
  SAVED_PRODUCT_LISTS_OWNER_ONLY_CODE,
  SavedProductListsUnavailableError,
} from "../../sdk/src/saved_product_lists";
import {
  MAX_SPACE_MANIFEST_BYTES,
  declaredSavedProductLists,
} from "../../sdk/src/saved_product_manifest";
import { requiredEnv, sendSpaceDaemonRequest } from "./daemon-rpc";

const SOCKET_ENV = "HATCH_SPACE_PRIVILEGED_SOCKET";
const SLUG_ENV = "HATCH_SPACE_SLUG";
const REQUEST_TIMEOUT_MS = 60_000;
const MAX_LISTS = 20;
const MAX_LIST_NAME_BYTES = 256;
const MAX_PRODUCTS = 500;
/** A product's stable photo identity: a lowercase SHA-256 hex digest. */
const IMAGE_SOURCE = /^[0-9a-f]{64}$/;
const IMAGE_KEY = /^saved-products\/[0-9a-f]{64}\.img$/;
const IMAGE_CONTENT_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
const MAX_SAVED_AT_BYTES = 128;
const PRICES = new Set<SavedProductPrice>(["current", "saved", "refreshing"]);
const PRODUCT_TYPES = new Set(["catalog", "marketplace", "browser"]);
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

export type SavedProductListsContext = {
  blobs: BlobClient;
  actionInvocationId: string;
  actionName: string;
  rootRequestId?: string;
  viewer?: LocalViewer | PeerViewer;
};

type WireItem = {
  product: SavedProductRecord;
  /** The photo this read carries, at the source's key; null when it carries none. */
  image: string | null;
  /** The product's photo identity; null when the product has no photo. */
  imageSource: string | null;
  savedAt: string | null;
  price: SavedProductPrice;
};
type WireList = { list: string; missing: boolean; items: WireItem[] };
type WireImage = { key: string; contentType: string; bytes: Buffer };

class MalformedResponseError extends Error {
  constructor(detail: string) {
    super(`saved product lists response was malformed: ${detail}`);
    this.name = "MalformedResponseError";
  }
}

function malformed(detail: string): never {
  throw new MalformedResponseError(detail);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseProduct(value: unknown, at: string): SavedProductRecord {
  if (
    !isRecord(value) ||
    typeof value.name !== "string" ||
    typeof value.url !== "string" ||
    !PRODUCT_TYPES.has(value.type as string)
  ) {
    malformed(`${at}.product is not a product card`);
  }
  return value as SavedProductRecord;
}

function parseItem(value: unknown, at: string): WireItem {
  if (!isRecord(value)) malformed(`${at} is not an object`);
  const product = parseProduct(value.product, at);
  if (!PRICES.has(value.price as SavedProductPrice)) malformed(`${at}.price is unknown`);
  const rawSource = value.image_source ?? null;
  let imageSource: string | null = null;
  if (rawSource !== null) {
    if (typeof rawSource !== "string" || !IMAGE_SOURCE.test(rawSource)) {
      malformed(`${at}.image_source is not a photo identity`);
    }
    imageSource = rawSource;
  }
  const rawImage = value.image ?? null;
  let image: string | null = null;
  if (rawImage !== null) {
    if (imageSource === null || rawImage !== imageKey(imageSource)) {
      malformed(`${at}.image is not the photo key of its image_source`);
    }
    image = rawImage;
  }
  const rawSavedAt = value.saved_at ?? null;
  let savedAt: string | null = null;
  if (rawSavedAt !== null) {
    if (typeof rawSavedAt !== "string" || Buffer.byteLength(rawSavedAt) > MAX_SAVED_AT_BYTES) {
      malformed(`${at}.saved_at is not a save time`);
    }
    savedAt = rawSavedAt;
  }
  return { product, image, imageSource, savedAt, price: value.price as SavedProductPrice };
}

function imageKey(source: string): string {
  return `saved-products/${source}.img`;
}

/** `url` with `v=<version>`, so a changed photo at the same key is fetched again. */
function versionedUrl(url: string, version: string): string {
  const hash = url.indexOf("#");
  const [base, fragment] = hash === -1 ? [url, ""] : [url.slice(0, hash), url.slice(hash)];
  const separator = base.includes("?") ? "&" : "?";
  return `${base}${separator}v=${encodeURIComponent(version)}${fragment}`;
}

/** A photo an earlier read stored at its key, when it is still one. */
function storedPhoto(metadata: BlobMetadata | null, key: string): string | null {
  if (
    metadata === null ||
    metadata.key !== key ||
    !IMAGE_CONTENT_TYPES.has(metadata.contentType) ||
    metadata.size <= 0 ||
    !IMAGE_SOURCE.test(metadata.etag)
  ) {
    return null;
  }
  return metadata.etag;
}

type Photo = { key: string; version: string; url: string };

function isListName(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && Buffer.byteLength(value) <= MAX_LIST_NAME_BYTES;
}

function parseLists(value: unknown, requested: readonly string[]): WireList[] {
  const useDeclaration = requested.length === 0;
  if (
    !Array.isArray(value) ||
    value.length > MAX_LISTS ||
    (!useDeclaration && value.length !== requested.length)
  ) {
    malformed("lists do not match the request");
  }
  const names = new Set<string>();
  let productCount = 0;
  return value.map((list, index) => {
    const at = `lists[${index}]`;
    if (
      !isRecord(list) ||
      !isListName(list.list) ||
      (!useDeclaration && list.list !== requested[index]) ||
      typeof list.missing !== "boolean" ||
      !Array.isArray(list.items)
    ) {
      malformed(`${at} does not match the request`);
    }
    if (names.has(list.list)) malformed(`${at} repeats a list name`);
    names.add(list.list);
    if (list.missing && list.items.length > 0) malformed(`${at} is missing but has items`);
    productCount += list.items.length;
    if (productCount > MAX_PRODUCTS) malformed("lists exceed the product budget");
    return {
      list: list.list,
      missing: list.missing,
      items: list.items.map((item, itemIndex) => parseItem(item, `${at}.items[${itemIndex}]`)),
    };
  });
}

function parseImages(value: unknown): Map<string, WireImage> {
  if (!Array.isArray(value)) malformed("images is not an array");
  const images = new Map<string, WireImage>();
  value.forEach((image: unknown, index) => {
    const at = `images[${index}]`;
    if (!isRecord(image)) malformed(`${at} is not an object`);
    const { key, content_type: contentType, data_base64: data } = image;
    if (
      typeof key !== "string" ||
      !IMAGE_KEY.test(key) ||
      typeof contentType !== "string" ||
      !IMAGE_CONTENT_TYPES.has(contentType) ||
      typeof data !== "string" ||
      data.length === 0 ||
      !BASE64.test(data)
    ) {
      malformed(`${at} is not a saved product photo`);
    }
    if (images.has(key)) malformed(`${at} repeats ${key}`);
    images.set(key, { key, contentType, bytes: Buffer.from(data, "base64") });
  });
  return images;
}

/** Checks the whole response before anything is written to the Space's blobs. */
export function parseSavedProductListsResult(
  result: unknown,
  requested: readonly string[],
): { lists: WireList[]; images: Map<string, WireImage> } {
  if (!isRecord(result) || result.kind !== "saved_product_lists") {
    malformed("no saved_product_lists result");
  }
  const lists = parseLists(result.lists, requested);
  const images = parseImages(result.images);
  const named = new Set<string>();
  for (const list of lists) {
    for (const item of list.items) {
      if (item.image === null) continue;
      if (!images.has(item.image)) malformed(`no photo for ${item.image}`);
      named.add(item.image);
    }
  }
  for (const key of images.keys()) {
    if (!named.has(key)) malformed(`photo ${key} is named by no item`);
  }
  return { lists, images };
}

export async function readSavedProductLists(
  ctx: SavedProductListsContext,
  lists: readonly string[] = [],
): Promise<SavedProductLists> {
  if (!Array.isArray(lists) || lists.length > MAX_LISTS) {
    throw new TypeError("ctx.tool.saved_product_lists takes at most 20 list names");
  }
  const requested = [...lists];
  if (requested.some((name) => !isListName(name))) {
    throw new TypeError("ctx.tool.saved_product_lists takes list names of 1 to 256 UTF-8 bytes");
  }
  if (new Set(requested).size !== requested.length) {
    throw new TypeError("ctx.tool.saved_product_lists takes unique list names");
  }
  // The daemon decides who the owner is; any other viewer never gets this far.
  if (ctx.viewer?.source !== "local" || ctx.viewer.isOwner !== true) {
    throw new SavedProductListsUnavailableError();
  }
  // Empty names ask the daemon for the Space's authoritative declaration.
  const request = {
    kind: "saved_product_lists",
    request_id: `space-saved-products-${randomUUID()}`,
    slug: requiredEnv(SLUG_ENV),
    action_name: ctx.actionName,
    action_invocation_id: ctx.actionInvocationId,
    lists: requested,
    refresh_prices: true,
    ...(ctx.rootRequestId !== undefined ? { root_request_id: ctx.rootRequestId } : {}),
  };
  const response = (await sendSpaceDaemonRequest(
    requiredEnv(SOCKET_ENV),
    request,
    REQUEST_TIMEOUT_MS,
  )) as { ok?: unknown; result?: unknown; error?: unknown; error_code?: unknown };
  if (response.ok !== true) {
    if (response.error_code === SAVED_PRODUCT_LISTS_OWNER_ONLY_CODE) {
      throw new SavedProductListsUnavailableError();
    }
    throw new Error(
      typeof response.error === "string" && response.error
        ? response.error
        : "saved product lists read failed",
    );
  }
  const parsed = parseSavedProductListsResult(response.result, requested);

  // Photos by key: this read's, then those earlier reads stored for products
  // whose photo this read left out.
  const photos = new Map<string, Photo | null>();
  for (const image of parsed.images.values()) {
    await ctx.blobs.put(image.key, image.bytes, { contentType: image.contentType });
    const version = createHash("sha256").update(image.bytes).digest("hex");
    const url = versionedUrl(await ctx.blobs.getUrl(image.key), version);
    photos.set(image.key, { key: image.key, version, url });
  }
  for (const list of parsed.lists) {
    for (const item of list.items) {
      if (item.imageSource === null) continue;
      const key = imageKey(item.imageSource);
      if (photos.has(key)) continue;
      const version = storedPhoto(await ctx.blobs.head(key), key);
      photos.set(
        key,
        version === null
          ? null
          : { key, version, url: versionedUrl(await ctx.blobs.getUrl(key), version) },
      );
    }
  }
  const photoOf = (item: WireItem): Photo | null =>
    item.imageSource === null ? null : (photos.get(imageKey(item.imageSource)) ?? null);
  return {
    lists: parsed.lists.map(
      (list): SavedProductList => ({
        list: list.list,
        missing: list.missing,
        items: list.items.map(
          (item): SavedProductListItem => {
            const photo = photoOf(item);
            return {
              product: item.product,
              image: photo?.url ?? null,
              imageKey: photo?.key ?? null,
              imageVersion: photo?.version ?? null,
              savedAt: item.savedAt,
              price: item.price,
            };
          },
        ),
      }),
    ),
  };
}

/**
 * The lists `space.json` declares, read for one invocation: a regular file of
 * at most 64 KiB, never through a link. A Space whose declaration is missing
 * or invalid declares none, so its saved copy shows nothing.
 */
export async function readDeclaredSavedProductLists(
  spaceDir: string,
): Promise<readonly string[] | undefined> {
  let file: fs.FileHandle | undefined;
  try {
    file = await fs.open(
      join(spaceDir, "space.json"),
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > MAX_SPACE_MANIFEST_BYTES) return undefined;
    const buffer = Buffer.alloc(MAX_SPACE_MANIFEST_BYTES + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await file.read(buffer, length, buffer.length - length, length);
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    if (length > MAX_SPACE_MANIFEST_BYTES) return undefined;
    return declaredSavedProductLists(JSON.parse(buffer.subarray(0, length).toString("utf8")));
  } catch {
    return undefined;
  } finally {
    await file?.close();
  }
}
