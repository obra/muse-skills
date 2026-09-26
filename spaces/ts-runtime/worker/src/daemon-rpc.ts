import { connect } from "node:net";

const MAX_REQUEST_FRAME_BYTES = 32 * 1024 * 1024;
// Privileged responses commonly carry base64-encoded file contents (e.g.
// reading an image file), which inflate ~1.33x over the raw bytes, so a 1 MiB
// cap is too small for common operations. Keep this in lockstep with
// SPACE_PRIVILEGED_MAX_RESPONSE_FRAME_BYTES in the daemon
// (hatch-server/src/daemon/runtime/space_privileged.rs), which writes these
// frames.
const MAX_RESPONSE_FRAME_BYTES = 32 * 1024 * 1024;

export type SpaceDaemonResponse =
  | { ok: true; result?: { kind?: string; [key: string]: unknown } }
  | { ok: false; error?: string };

export function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`missing required worker environment variable ${name}`);
  }
  return value;
}

function encodeFrame(value: unknown): Buffer {
  const payload = Buffer.from(JSON.stringify(value), "utf8");
  if (payload.length > MAX_REQUEST_FRAME_BYTES) {
    throw new Error(`web artifact daemon request frame too large: ${payload.length} bytes`);
  }
  const frame = Buffer.allocUnsafe(4 + payload.length);
  frame.writeUInt32BE(payload.length, 0);
  payload.copy(frame, 4);
  return frame;
}

function decodeFrame(buffer: Buffer): SpaceDaemonResponse {
  if (buffer.length < 4) {
    throw new Error("web artifact daemon response was truncated");
  }
  const len = buffer.readUInt32BE(0);
  if (len > MAX_RESPONSE_FRAME_BYTES) {
    throw new Error(`web artifact daemon response frame too large: ${len} bytes`);
  }
  if (buffer.length - 4 < len) {
    throw new Error("web artifact daemon response ended before full frame arrived");
  }
  return JSON.parse(buffer.subarray(4, 4 + len).toString("utf8")) as SpaceDaemonResponse;
}

export async function sendSpaceDaemonRequest(
  socketPath: string,
  request: unknown,
  timeout?: number,
): Promise<SpaceDaemonResponse> {
  const frame = encodeFrame(request);
  const chunks: Buffer[] = [];

  return await new Promise<SpaceDaemonResponse>((resolve, reject) => {
    const socket = connect(socketPath);
    let settled = false;
    const timer =
      timeout === undefined
        ? undefined
        : setTimeout(() => {
            finish(
              new Error(
                `web artifact daemon request exceeded ${timeout}ms wall-clock budget`,
              ),
            );
          }, timeout);

    function finish(err?: Error, response?: SpaceDaemonResponse): void {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      socket.destroy();
      if (err) reject(err);
      else if (response) resolve(response);
      else reject(new Error("web artifact daemon socket closed without a response"));
    }

    socket.on("connect", () => {
      socket.write(frame);
    });
    socket.on("data", (chunk) => {
      chunks.push(Buffer.from(chunk));
    });
    socket.on("end", () => {
      try {
        finish(undefined, decodeFrame(Buffer.concat(chunks)));
      } catch (err) {
        finish(err instanceof Error ? err : new Error(String(err)));
      }
    });
    socket.on("error", (err) => finish(err));
  });
}
