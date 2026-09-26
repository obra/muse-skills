import { createHash } from "node:crypto";
import { mkdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";

import { createClient, type Client, type InArgs, type Row } from "@libsql/client";
import type {
  BlobClient,
  BlobMetadata,
  BlobPutData,
  BlobPutOptions,
} from "@hatch/space-sdk";

const DEFAULT_CONTENT_TYPE = "application/octet-stream";


function validateKey(key: string): string {
  const trimmed = key.trim();
  if (!trimmed) {
    throw new Error("ctx.blobs requires a non-empty key");
  }
  if (trimmed.startsWith("/") || trimmed.includes("\\")) {
    throw new Error("ctx.blobs keys must be relative POSIX paths");
  }
  const parts = trimmed.split("/");
  if (parts.some((part) => part === "" || part === "." || part === "..")) {
    throw new Error("ctx.blobs keys cannot contain empty or dot path segments");
  }
  return trimmed;
}

function validatePrefix(prefix: string): string {
  const trimmed = prefix.trim();
  if (!trimmed) {
    return "";
  }
  if (trimmed.startsWith("/") || trimmed.includes("\\")) {
    throw new Error("ctx.blobs prefixes must be relative POSIX paths");
  }
  const parts = trimmed.endsWith("/")
    ? trimmed.slice(0, -1).split("/")
    : trimmed.split("/");
  if (parts.some((part) => part === "" || part === "." || part === "..")) {
    throw new Error("ctx.blobs prefixes cannot contain empty or dot path segments");
  }
  return trimmed;
}

function pathWithin(root: string, relpath: string): string {
  const resolvedRoot = resolve(root);
  const resolvedPath = resolve(resolvedRoot, relpath);
  const relativePath = relative(resolvedRoot, resolvedPath);
  if (
    relativePath === "" ||
    relativePath === ".." ||
    relativePath.startsWith(`..${sep}`)
  ) {
    throw new Error("ctx.blobs key escapes blob storage root");
  }
  return resolvedPath;
}

function objectPath(root: string, key: string): string {
  return pathWithin(join(root, "objects"), key);
}

// Object bytes live under a hashed, sharded id — NOT under objects/<key> — so a
// long or reserved-char key (any /-segment over the filesystem's 255-byte name
// limit) can't break the write and apps never need to truncate keys. The id is
// recorded in the index; legacy rows (no id) keep resolving to objects/<key>
// via the daemon's dual-read serve path. docs/spaces-blob-key-roundtrip-fix.md #2.
function objectIdForKey(key: string): string {
  return createHash("sha256").update(key, "utf8").digest("hex");
}

function objectPathForId(root: string, objectId: string): string {
  return pathWithin(join(root, "objects"), join(objectId.slice(0, 2), objectId));
}

async function blobDataToBytes(data: BlobPutData): Promise<Uint8Array> {
  if (typeof data === "string") {
    return new TextEncoder().encode(data);
  }
  if (data instanceof ArrayBuffer) {
    return new Uint8Array(data);
  }
  if (ArrayBuffer.isView(data)) {
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  }
  if (data instanceof Blob) {
    return new Uint8Array(await data.arrayBuffer());
  }
  throw new Error("ctx.blobs.put received unsupported data");
}

function visibilityFromOptions(
  options: BlobPutOptions | undefined,
): "private" | "public" {
  return options?.public === true ? "public" : "private";
}

function etagForBytes(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

// Carry the logical key through the URL as a single opaque base64url token
// (RFC 4648 §5, no padding; alphabet [A-Za-z0-9_-]). The token contains no `%`
// and no `/`, so it is immune to the lossy `nginx (percent-decode +
// merge_slashes) -> axum (percent-decode)` round-trip that mangled keys carried
// as URL path structure (e.g. keys holding `%`, encoded slashes, or other
// reserved bytes). The daemon decodes the token once and re-applies the same
// traversal validation to the recovered key. See
// docs/spaces-blob-key-roundtrip-fix.md.
function encodeBlobKeyToken(key: string): string {
  return Buffer.from(key, "utf8").toString("base64url");
}

async function openIndex(root: string): Promise<Client> {
  await mkdir(root, { recursive: true });
  const client = createClient({ url: `file:${join(root, "index.sqlite")}` });
  await client.execute("PRAGMA journal_mode = WAL");
  await client.execute(`
    CREATE TABLE IF NOT EXISTS blobs (
      key TEXT PRIMARY KEY NOT NULL,
      content_type TEXT NOT NULL,
      size_bytes INTEGER NOT NULL,
      etag TEXT NOT NULL,
      visibility TEXT NOT NULL CHECK (visibility IN ('private', 'public')),
      created_at_ms INTEGER NOT NULL,
      updated_at_ms INTEGER NOT NULL,
      object_id TEXT
    )
  `);
  // Lazily migrate indexes created before object-path decoupling: new writes
  // populate object_id, legacy rows stay null and serve from objects/<key>.
  const columns = await client.execute("PRAGMA table_info(blobs)");
  const hasObjectId = columns.rows.some((row) => row.name === "object_id");
  if (!hasObjectId) {
    await client.execute("ALTER TABLE blobs ADD COLUMN object_id TEXT");
  }
  return client;
}

async function withIndex<T>(
  root: string,
  callback: (client: Client) => Promise<T>,
): Promise<T> {
  const client = await openIndex(root);
  try {
    return await callback(client);
  } finally {
    client.close();
  }
}

function rowString(row: Row, column: string): string | null {
  const value = row[column];
  return typeof value === "string" ? value : null;
}

function rowNumber(row: Row, column: string): number | null {
  const value = row[column];
  return typeof value === "number" ? value : null;
}

function metadataFromRow(row: Row): BlobMetadata | null {
  const key = rowString(row, "key");
  const contentType = rowString(row, "content_type");
  const sizeBytes = rowNumber(row, "size_bytes");
  const etag = rowString(row, "etag");
  const visibility = rowString(row, "visibility");
  const createdAtMs = rowNumber(row, "created_at_ms");
  const updatedAtMs = rowNumber(row, "updated_at_ms");
  if (
    key === null ||
    contentType === null ||
    sizeBytes === null ||
    etag === null ||
    (visibility !== "private" && visibility !== "public") ||
    createdAtMs === null ||
    updatedAtMs === null
  ) {
    return null;
  }
  return {
    key,
    contentType,
    size: sizeBytes,
    sizeBytes,
    etag,
    visibility,
    createdAtMs,
    updatedAtMs,
    public: visibility === "public",
  };
}

async function queryMetadata(root: string, key: string): Promise<BlobMetadata | null> {
  return await withIndex(root, async (client) => {
    const result = await client.execute({
      sql: "SELECT key, content_type, size_bytes, etag, visibility, created_at_ms, updated_at_ms FROM blobs WHERE key = ?",
      args: [key],
    });
    const row = result.rows[0];
    return row ? metadataFromRow(row) : null;
  });
}

export function createBlobClient(args: {
  spaceDir: string;
  blobDir?: string;
}): BlobClient {
  const root = args.blobDir ?? join(args.spaceDir, "blobs");
  return {
    async put(key, data, options) {
      const normalizedKey = validateKey(key);
      const bytes = await blobDataToBytes(data);
      const objectId = objectIdForKey(normalizedKey);
      const finalPath = objectPathForId(root, objectId);
      const tempPath = `${finalPath}.${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}.tmp`;
      await mkdir(dirname(finalPath), { recursive: true });
      await writeFile(tempPath, bytes);

      const contentType = options?.contentType?.trim() || DEFAULT_CONTENT_TYPE;
      const etag = etagForBytes(bytes);
      const visibility = visibilityFromOptions(options);
      const nowMs = Date.now();

      await withIndex(root, async (client) => {
        await rename(tempPath, finalPath);
        const objectStat = await stat(finalPath);
        await client.execute({
          sql: `
            INSERT INTO blobs (
              key,
              content_type,
              size_bytes,
              etag,
              visibility,
              created_at_ms,
              updated_at_ms,
              object_id
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(key) DO UPDATE SET
              content_type = excluded.content_type,
              size_bytes = excluded.size_bytes,
              etag = excluded.etag,
              visibility = excluded.visibility,
              updated_at_ms = excluded.updated_at_ms,
              object_id = excluded.object_id
          `,
          args: [
            normalizedKey,
            contentType,
            objectStat.size,
            etag,
            visibility,
            nowMs,
            nowMs,
            objectId,
          ] satisfies InArgs,
        });
      });

      // Backfill cleanup: if this key predated the migration its bytes were at
      // objects/<key>; the row now points at the sharded id path, so drop the
      // stale legacy file. Best-effort — a missing or over-long legacy path is
      // expected and ignored.
      await rm(objectPath(root, normalizedKey), { force: true }).catch(() => {});
    },
    async getUrl(key) {
      const normalizedKey = validateKey(key);
      const metadata = await queryMetadata(root, normalizedKey);
      if (!metadata) {
        throw new Error(`ctx.blobs key not found: ${normalizedKey}`);
      }
      // Document-relative, NOT root-absolute: the Space's document base is
      // `/spaces/v2/<slug>/` at the origin root in prod but behind a
      // `/backend/<sid>/` proxy prefix in the annotation rig — a leading slash
      // would drop that prefix and 404. Mirrors `./assets/` and Cloudflare's
      // `./blobs/`. Any ctx helper returning a daemon-served path for the page
      // to render must stay relative.
      return `./blobs/${encodeBlobKeyToken(normalizedKey)}`;
    },
    async delete(key) {
      const normalizedKey = validateKey(key);
      const objectId = await withIndex(root, async (client) => {
        const existing = await client.execute({
          sql: "SELECT object_id FROM blobs WHERE key = ?",
          args: [normalizedKey],
        });
        const row = existing.rows[0];
        await client.execute({
          sql: "DELETE FROM blobs WHERE key = ?",
          args: [normalizedKey],
        });
        return row ? rowString(row, "object_id") : null;
      });
      // Remove the object from whichever layout it used (sharded id and/or the
      // legacy key path); best-effort on both so a half-migrated blob can't leak.
      if (objectId) {
        await rm(objectPathForId(root, objectId), { force: true }).catch(() => {});
      }
      await rm(objectPath(root, normalizedKey), { force: true }).catch(() => {});
    },
    async head(key) {
      return await queryMetadata(root, validateKey(key));
    },
    async list(prefix = "") {
      const normalizedPrefix = validatePrefix(prefix);
      const escapedPrefix = normalizedPrefix
        .replace(/\\/g, "\\\\")
        .replace(/%/g, "\\%")
        .replace(/_/g, "\\_");
      return await withIndex(root, async (client) => {
        const result = await client.execute({
          sql: `
            SELECT key, content_type, size_bytes, etag, visibility, created_at_ms, updated_at_ms
            FROM blobs
            WHERE key LIKE ? ESCAPE '\\'
            ORDER BY key ASC
          `,
          args: [`${escapedPrefix}%`],
        });
        return result.rows
          .map(metadataFromRow)
          .filter((item): item is BlobMetadata => item !== null);
      });
    },
  };
}
