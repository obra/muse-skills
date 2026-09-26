const MAX_REQUEST_FRAME_BYTES = 4 * 1024 * 1024;
const MAX_RESPONSE_FRAME_BYTES = 4 * 1024 * 1024;

export function encodeWebSearchFrame(value: unknown): Buffer {
  const payload = Buffer.from(JSON.stringify(value), "utf8");
  if (payload.length > MAX_REQUEST_FRAME_BYTES) {
    throw new Error(`artifact web search request frame too large: ${payload.length} bytes`);
  }
  const frame = Buffer.allocUnsafe(4 + payload.length);
  frame.writeUInt32BE(payload.length, 0);
  payload.copy(frame, 4);
  return frame;
}

export function decodeWebSearchFrame<T>(buffer: Buffer): T {
  if (buffer.length < 4) {
    throw new Error("artifact web search response was truncated");
  }
  const len = buffer.readUInt32BE(0);
  if (len > MAX_RESPONSE_FRAME_BYTES) {
    throw new Error(`artifact web search response frame too large: ${len} bytes`);
  }
  if (buffer.length - 4 < len) {
    throw new Error("artifact web search response ended before full frame arrived");
  }
  return JSON.parse(buffer.subarray(4, 4 + len).toString("utf8")) as T;
}
