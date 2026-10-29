// A shared app keeps its data on Cloudflare. When the daemon runs one of its
// actions on the VM, `ctx.db` statements and `ctx.blobs` calls go through the
// daemon to the published worker, which applies them to D1 and R2. The database speaks D1's interface
// so drizzle's D1 driver returns exactly what the action would see there.

import { drizzle } from "drizzle-orm/d1";
import type { BlobClient, SpaceDbAccessor } from "@hatch/space-sdk";
import { requiredEnv, sendSpaceDaemonRequest } from "./daemon-rpc";

const SOCKET_ENV = "HATCH_SPACE_INFERENCE_SOCKET";
const BYTES_TAG = "$hatch_bytes";
const BIGINT_TAG = "$hatch_bigint";

export interface SharedDataInvocation {
  slug: string;
  action: string;
  invocationId: string;
}

// Binary values and bigints do not survive JSON, so both sides tag them.
export function encodeSharedValue(value: unknown): unknown {
  if (value instanceof ArrayBuffer) return { [BYTES_TAG]: Buffer.from(value).toString("base64") };
  if (ArrayBuffer.isView(value)) {
    return {
      [BYTES_TAG]: Buffer.from(value.buffer, value.byteOffset, value.byteLength).toString("base64"),
    };
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
      const bytes = Buffer.from(record[BYTES_TAG] as string, "base64");
      return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    }
    if (keys.length === 1 && typeof record[BIGINT_TAG] === "string") {
      return BigInt(record[BIGINT_TAG] as string);
    }
    return Object.fromEntries(keys.map((key) => [key, decodeSharedValue(record[key])]));
  }
  return value;
}

async function sendOperation(
  invocation: SharedDataInvocation,
  operation: Record<string, unknown>,
): Promise<unknown> {
  const response = await sendSpaceDaemonRequest(requiredEnv(SOCKET_ENV), {
    kind: "shared_data",
    request_id: crypto.randomUUID(),
    slug: invocation.slug,
    action: invocation.action,
    action_invocation_id: invocation.invocationId,
    operation,
  });
  if (!response.ok) {
    throw new Error(response.error ?? "shared data operation failed");
  }
  const outcome = response.result?.result as
    | { ok: true; result: unknown }
    | { ok: false; error: string }
    | undefined;
  if (outcome?.ok !== true) {
    throw new Error(outcome?.error ?? "shared data operation returned no result");
  }
  return decodeSharedValue(outcome.result);
}

type StatementMethod = "all" | "raw" | "run" | "first";

class SharedStatement {
  constructor(
    private readonly invocation: SharedDataInvocation,
    readonly sql: string,
    readonly params: unknown[] = [],
  ) {}

  bind(...params: unknown[]): SharedStatement {
    return new SharedStatement(this.invocation, this.sql, params);
  }

  all(): Promise<unknown> {
    return this.execute("all");
  }

  raw(): Promise<unknown> {
    return this.execute("raw");
  }

  run(): Promise<unknown> {
    return this.execute("run");
  }

  first(column?: string): Promise<unknown> {
    return this.execute("first", column);
  }

  private execute(method: StatementMethod, column?: string): Promise<unknown> {
    return sendOperation(this.invocation, {
      type: "statement",
      sql: this.sql,
      params: encodeSharedValue(this.params),
      method,
      ...(column !== undefined ? { column } : {}),
    });
  }
}

class SharedDatabase {
  constructor(private readonly invocation: SharedDataInvocation) {}

  prepare(sql: string): SharedStatement {
    return new SharedStatement(this.invocation, sql);
  }

  batch(statements: SharedStatement[]): Promise<unknown> {
    return sendOperation(this.invocation, {
      type: "batch",
      statements: statements.map((statement) => ({
        sql: statement.sql,
        params: encodeSharedValue(statement.params),
      })),
    });
  }
}

export function createSharedDbAccessor(invocation: SharedDataInvocation): SpaceDbAccessor {
  let db: unknown;
  return (() => {
    db ??= drizzle(new SharedDatabase(invocation) as never);
    return db;
  }) as SpaceDbAccessor;
}

/** `ctx.blobs` against the shared app's file storage on Cloudflare. */
export function createSharedBlobClient(invocation: SharedDataInvocation): BlobClient {
  const send = (method: string, fields: Record<string, unknown>) =>
    sendOperation(invocation, { type: "blob", method, ...fields });
  return {
    async put(key, data, options) {
      const body = data instanceof Blob ? await data.arrayBuffer() : data;
      await send("put", { key, data: encodeSharedValue(body), options: options ?? {} });
    },
    async getUrl(key, options) {
      return (await send("getUrl", { key, options: options ?? {} })) as string;
    },
    async delete(key) {
      await send("delete", { key });
    },
    async head(key) {
      return (await send("head", { key })) as Awaited<ReturnType<BlobClient["head"]>>;
    },
    async list(prefix) {
      return (await send("list", { prefix: prefix ?? "" })) as Awaited<ReturnType<BlobClient["list"]>>;
    },
  };
}
