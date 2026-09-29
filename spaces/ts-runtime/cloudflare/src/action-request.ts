import type { ActionRpcRequest } from "./sdk";

// Fits an 8 MiB attachment encoded as base64, including its JSON metadata.
const MAX_ACTION_BYTES = 12 * 1024 * 1024;

export class ActionRequestError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}

export async function readActionRequest(request: Request): Promise<ActionRpcRequest | { kind: "catalog" }> {
  if (request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") {
    throw new ActionRequestError("Request body must be JSON", 415);
  }
  const reader = request.body?.getReader();
  if (!reader) throw new ActionRequestError("Request body is required", 400);
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > MAX_ACTION_BYTES) {
        await reader.cancel();
        throw new ActionRequestError("Action request exceeds 12 MiB", 413);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  let body: unknown;
  try { body = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
  catch { throw new ActionRequestError("Request body must be JSON", 400); }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new ActionRequestError("Action request must be an object", 400);
  }
  const payload = body as Record<string, unknown>;
  if (payload.kind !== undefined) {
    if (payload.kind === "catalog" && Object.keys(payload).length === 1) return { kind: "catalog" };
    throw new ActionRequestError("Invalid action request kind", 400);
  }
  if (typeof payload.action !== "string" || !payload.action.trim() || payload.action.length > 128) {
    throw new ActionRequestError("Invalid action name", 400);
  }
  if (payload.actionCallId !== undefined &&
      (typeof payload.actionCallId !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(payload.actionCallId))) {
    throw new ActionRequestError("Invalid action call ID", 400);
  }
  return payload as unknown as ActionRpcRequest;
}
