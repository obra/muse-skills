// Length-prefixed JSON framing for the space-media UDS. The response carries
// base64-encoded image bytes, so the response cap is much larger than the
// web-search channel's.
const MAX_REQUEST_FRAME_BYTES = 256 * 1024;
const MAX_RESPONSE_FRAME_BYTES = 32 * 1024 * 1024;

export function encodeSpaceMediaFrame(value: unknown): Buffer {
  const payload = Buffer.from(JSON.stringify(value), "utf8");
  if (payload.length > MAX_REQUEST_FRAME_BYTES) {
    throw new Error(`space media request frame too large: ${payload.length} bytes`);
  }
  const frame = Buffer.allocUnsafe(4 + payload.length);
  frame.writeUInt32BE(payload.length, 0);
  payload.copy(frame, 4);
  return frame;
}

export function decodeSpaceMediaFrame<T>(buffer: Buffer): T {
  if (buffer.length < 4) {
    throw new Error("space media response was truncated");
  }
  const len = buffer.readUInt32BE(0);
  if (len > MAX_RESPONSE_FRAME_BYTES) {
    throw new Error(`space media response frame too large: ${len} bytes`);
  }
  if (buffer.length - 4 < len) {
    throw new Error("space media response ended before full frame arrived");
  }
  return JSON.parse(buffer.subarray(4, 4 + len).toString("utf8")) as T;
}
