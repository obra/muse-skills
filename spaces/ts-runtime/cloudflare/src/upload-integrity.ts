import type { BlobPutData } from "./sdk";

export type UploadChecker = {
  checkUpload(request: { bytes: Uint8Array; contentType: string; key: string }): Promise<unknown>;
};

const MAX_BYTES = 8 * 1024 * 1024;
const RPC_ERRORS = new Set([
  "upload_integrity:bad_request", "upload_integrity:replayed", "upload_integrity:too_large",
  "upload_integrity:unsupported_type", "upload_integrity:body_mismatch", "upload_integrity:rate_limited",
]);

async function snapshot(data: BlobPutData): Promise<Uint8Array> {
  const size = typeof data === "string" ? data.length
    : data instanceof Blob ? data.size
    : data instanceof ArrayBuffer || ArrayBuffer.isView(data) ? data.byteLength
    : undefined;
  if (size === undefined || size === 0) throw new Error("upload_integrity:bad_request");
  if (size > MAX_BYTES) throw new Error("upload_integrity:too_large");
  let bytes: Uint8Array;
  if (typeof data === "string") bytes = new TextEncoder().encode(data);
  else if (data instanceof Blob) bytes = new Uint8Array(await data.arrayBuffer());
  else if (ArrayBuffer.isView(data)) bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength).slice();
  else bytes = new Uint8Array(data).slice();
  if (bytes.length === 0) throw new Error("upload_integrity:bad_request");
  if (bytes.length > MAX_BYTES) throw new Error("upload_integrity:too_large");
  return bytes;
}

// RFC 9110 media-type grammar, excluding CTLs (including HTAB).
const MIME_TOKEN = "[!#$%&'*+.^_`|~A-Za-z0-9-]+";
const MIME_QUOTED_STRING = String.raw`"(?:[\x20-\x21\x23-\x5b\x5d-\x7e\x80-\xff]|\\[\x20-\x7e\x80-\xff])*"`;
const MIME_TYPE = new RegExp(`^(${MIME_TOKEN}/${MIME_TOKEN})(?: *; *${MIME_TOKEN}=(?:${MIME_TOKEN}|${MIME_QUOTED_STRING}))*$`);

function storageContentType(type: string, original: string): string {
  const match = original.length <= 256 ? MIME_TYPE.exec(original) : null;
  // Require full consumption: $ can match before a final newline.
  return match?.[0] === original && match[1]?.toLowerCase() === type ? original : type;
}

// Check-only contract v1 rev 1.9. Tickets and credentials stay in the dispatcher.
export async function checkBlob(
  data: BlobPutData,
  contentType = "application/octet-stream",
  hatch: UploadChecker | undefined,
  key: string,
) {
  const bytes = await snapshot(data);
  if (typeof contentType !== "string") throw new Error("upload_integrity:unsupported_type");
  const originalType = contentType;
  contentType = contentType.split(";", 1)[0]!.trim().toLowerCase();
  if (contentType.length > 127 || !/^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/.test(contentType)) {
    throw new Error("upload_integrity:unsupported_type");
  }
  if (new TextEncoder().encode(key).length > 1024) {
    throw new Error("upload_integrity:bad_request");
  }
  if (!hatch || typeof hatch.checkUpload !== "function") throw new Error("upload_integrity:unavailable");
  let timer: ReturnType<typeof setTimeout> | undefined;
  let result: unknown;
  try {
    result = await Promise.race([
      hatch.checkUpload({ bytes, contentType, key }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("upload_integrity:unavailable")), 30_000);
      }),
    ]);
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    throw new Error(RPC_ERRORS.has(message) ? message : "upload_integrity:unavailable");
  } finally {
    clearTimeout(timer);
  }
  if (typeof result !== "object" || result === null || Array.isArray(result) ||
      !("verdict" in result) || (result.verdict !== "allow" && result.verdict !== "block") ||
      !("checkId" in result) || typeof result.checkId !== "string" || result.checkId.length === 0 || result.checkId.length > 128 ||
      !("receipt" in result) || (result.receipt !== null && typeof result.receipt !== "string")) {
    throw new Error("upload_integrity:unavailable");
  }
  if (result.verdict === "block") throw new Error("upload_integrity:blocked");
  return { bytes, contentType: storageContentType(contentType, originalType), customMetadata: { check_id: result.checkId } };
}
