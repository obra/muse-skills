// Applies one database statement or file call from a shared app's action that
// the owner's VM runs locally (the local worker's `shared_data.ts` sends them).
// Values go back as D1 and the blob client return them, so the action sees
// what it would see running here.

import type { BlobClient } from "./sdk";

type D1Statement = {
  bind(...values: unknown[]): D1Statement;
  all(): Promise<unknown>;
  raw(): Promise<unknown>;
  run(): Promise<unknown>;
  first(column?: string): Promise<unknown>;
};

export type SharedDataDatabase = {
  prepare(sql: string): D1Statement;
  batch(statements: D1Statement[]): Promise<unknown>;
};

// The daemon runs a shared app's actions on the VM only when its published
// worker carries this marker.
export const SHARED_DATA_PROTOCOL = "hatch-shared-data-v1";
const BYTES_TAG = "$hatch_bytes";
const BIGINT_TAG = "$hatch_bigint";

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  }
  return btoa(binary);
}

export function encodeSharedValue(value: unknown): unknown {
  if (value instanceof ArrayBuffer) return { [BYTES_TAG]: bytesToBase64(new Uint8Array(value)) };
  if (ArrayBuffer.isView(value)) {
    return { [BYTES_TAG]: bytesToBase64(new Uint8Array(value.buffer, value.byteOffset, value.byteLength)) };
  }
  if (typeof value === "bigint") return { [BIGINT_TAG]: value.toString() };
  if (Array.isArray(value)) return value.map(encodeSharedValue);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, encodeSharedValue(item)]));
  }
  return value;
}

export function decodeSharedValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(decodeSharedValue);
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record);
    if (keys.length === 1 && typeof record[BYTES_TAG] === "string") {
      return Uint8Array.from(atob(record[BYTES_TAG] as string), (character) => character.charCodeAt(0)).buffer;
    }
    if (keys.length === 1 && typeof record[BIGINT_TAG] === "string") {
      return BigInt(record[BIGINT_TAG] as string);
    }
    return Object.fromEntries(keys.map((key) => [key, decodeSharedValue(record[key])]));
  }
  return value;
}

function text(value: unknown, field: string): string {
  if (typeof value !== "string") throw new Error(`shared data operation is missing ${field}`);
  return value;
}

function params(value: unknown): unknown[] {
  const decoded = decodeSharedValue(value ?? []);
  if (!Array.isArray(decoded)) throw new Error("shared data operation params must be a list");
  return decoded;
}

async function runStatement(db: SharedDataDatabase, operation: Record<string, unknown>): Promise<unknown> {
  const statement = db.prepare(text(operation.sql, "sql")).bind(...params(operation.params));
  switch (operation.method) {
    case "all":
      return statement.all();
    case "raw":
      return statement.raw();
    case "run":
      return statement.run();
    case "first":
      return typeof operation.column === "string" ? statement.first(operation.column) : statement.first();
    default:
      throw new Error("unknown shared data statement method");
  }
}

function options<T>(value: unknown): T {
  return (value !== null && typeof value === "object" ? value : {}) as T;
}

async function runBlob(blobs: BlobClient, operation: Record<string, unknown>): Promise<unknown> {
  switch (operation.method) {
    case "put": {
      const data = decodeSharedValue(operation.data);
      if (typeof data !== "string" && !(data instanceof ArrayBuffer)) {
        throw new Error("shared file data must be text or bytes");
      }
      return blobs.put(text(operation.key, "key"), data, options(operation.options));
    }
    case "getUrl":
      return blobs.getUrl(text(operation.key, "key"), options(operation.options));
    case "delete":
      return blobs.delete(text(operation.key, "key"));
    case "head":
      return blobs.head(text(operation.key, "key"));
    case "list":
      return blobs.list(typeof operation.prefix === "string" ? operation.prefix : "");
    default:
      throw new Error("unknown shared file method");
  }
}

async function runOperation(
  db: SharedDataDatabase,
  blobs: BlobClient,
  operation: Record<string, unknown>,
): Promise<unknown> {
  switch (operation.type) {
    case "blob":
      return runBlob(blobs, operation);
    case "statement":
      return runStatement(db, operation);
    case "batch": {
      if (!Array.isArray(operation.statements)) throw new Error("shared data batch has no statements");
      return db.batch(
        operation.statements.map((item) => {
          const statement = item as Record<string, unknown>;
          return db.prepare(text(statement.sql, "sql")).bind(...params(statement.params));
        }),
      );
    }
    default:
      throw new Error("unknown shared data operation");
  }
}

/** The operation's result, or the error the action would have seen here. */
export async function runSharedDataOperation(
  db: SharedDataDatabase,
  blobs: BlobClient,
  operation: Record<string, unknown>,
): Promise<{ ok: true; result: unknown } | { ok: false; error: string }> {
  try {
    return { ok: true, result: encodeSharedValue(await runOperation(db, blobs, operation)) };
  } catch (error) {
    // A checker outage is the platform's, not the app's: let the request fail
    // so the VM reports the shared app unavailable instead of an action error.
    if (error instanceof Error && error.message === "upload_integrity:unavailable") throw error;
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}
