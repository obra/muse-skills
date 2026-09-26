// Base64 encoding for browser file uploads.
//
// The obvious one-liner — `btoa(String.fromCharCode(...new Uint8Array(buf)))`
// — passes every byte as a separate JS argument and throws "RangeError:
// Maximum call stack size exceeded" on multi-megabyte payloads, which is the
// size class of every phone photo. Spaces that ship uploads through an action
// request (e.g. into `ctx.inference.complete`'s `images` option) must encode
// with these helpers instead of hand-rolling the conversion.

/**
 * Base64-encode raw bytes. Uses the engine's native
 * `Uint8Array.prototype.toBase64` when present; older engines fall back to
 * building the intermediate binary string in bounded 32 KB chunks (small
 * enough to never hit the call-argument limit, large enough that a phone
 * photo costs a few hundred calls instead of millions) and encoding once
 * with `btoa`. Safe for payloads of any size a Space realistically accepts.
 */
export function bytesToBase64(bytes: Uint8Array): string {
  const native = bytes as Uint8Array & { toBase64?: () => string };
  if (typeof native.toBase64 === "function") {
    return native.toBase64();
  }
  const chunkSize = 0x8000;
  let binary = "";
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode.apply(null, chunk as unknown as number[]);
  }
  return btoa(binary);
}

/**
 * Read a browser `File`/`Blob` (file input, drag-drop, camera capture) into
 * the `{ dataBase64, mimeType }` shape `ctx.inference.complete` accepts in
 * its `images` option. Pass the result through the action request; the
 * server hands it to inference (or `ctx.blobs`) without re-encoding.
 */
export async function fileToBase64(
  file: Blob,
): Promise<{ dataBase64: string; mimeType: string }> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  return {
    dataBase64: bytesToBase64(bytes),
    mimeType: file.type || "application/octet-stream",
  };
}
