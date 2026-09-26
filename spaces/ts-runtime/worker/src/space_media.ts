import { randomUUID } from "node:crypto";
import { connect } from "node:net";

import type {
  BlobClient,
  GenerateMediaOptions,
  GeneratedMedia,
} from "@hatch/space-sdk";

import {
  decodeSpaceMediaFrame,
  encodeSpaceMediaFrame,
} from "./space_media_frame";

const SOCKET_ENV = "HATCH_SPACE_MEDIA_SOCKET";
const SLUG_ENV = "HATCH_SPACE_SLUG";
// The media CLI owns up to three 60s requests plus 126s of bounded retry waits.
// Keep the socket supervisor beyond that end-to-end budget so it can return the
// terminal upstream result instead of severing the retry owner mid-attempt.
const DEFAULT_TIMEOUT_MS = 316 * 1000;

type GenerateImageRequest = {
  kind: "generate_image";
  request_id: string;
  slug: string;
  prompt: string;
  orientation: "square" | "landscape" | "portrait";
  action_invocation_id?: string;
  action_name?: string;
  root_request_id?: string;
};

type GenerateImageResult = {
  kind: "generate_image";
  data_base64: string;
  content_type: string;
  ext: string;
  bytes: number;
};

type RawResponse =
  | { ok: true; result?: GenerateImageResult }
  | { ok: false; error?: string };

export type MediaToolContext = {
  actionInvocationId?: string;
  actionName?: string;
  rootRequestId?: string;
};

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`missing required worker environment variable ${name}`);
  }
  return value;
}

async function sendGenerate(
  request: GenerateImageRequest,
  timeout: number,
): Promise<GenerateImageResult> {
  const socketPath = requiredEnv(SOCKET_ENV);
  const frame = encodeSpaceMediaFrame(request);
  const chunks: Buffer[] = [];

  const raw = await new Promise<RawResponse>((resolve, reject) => {
    const socket = connect(socketPath);
    let settled = false;
    const timer = setTimeout(() => {
      finish(new Error(`web artifact media generation exceeded ${timeout}ms wall-clock budget`));
    }, timeout);

    function finish(err?: Error, response?: RawResponse): void {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (err) reject(err);
      else if (response) resolve(response);
      else reject(new Error("web artifact media socket closed without a response"));
    }

    socket.on("connect", () => {
      socket.write(frame);
    });
    socket.on("data", (chunk) => {
      chunks.push(Buffer.from(chunk));
    });
    socket.on("end", () => {
      try {
        finish(undefined, decodeSpaceMediaFrame<RawResponse>(Buffer.concat(chunks)));
      } catch (err) {
        finish(err instanceof Error ? err : new Error(String(err)));
      }
    });
    socket.on("error", (err) => finish(err));
  });

  if (raw.ok !== true) {
    throw new Error(raw.error || "web artifact media generation failed");
  }
  if (!raw.result || raw.result.kind !== "generate_image") {
    throw new Error("web artifact media response did not contain a generate_image result");
  }
  return raw.result;
}

/**
 * Generate an image via the daemon and store it in the Space's own blob store,
 * returning a durable own-origin URL + blob key. The daemon does the generation
 * (no cell egress); the bytes are persisted in `ctx.blobs` so the rendered URL
 * never expires and is same-origin.
 */
export async function generateMedia(
  blobs: BlobClient,
  prompt: string,
  options: GenerateMediaOptions = {},
  ctx: MediaToolContext = {},
): Promise<GeneratedMedia> {
  const trimmed = prompt.trim();
  if (!trimmed) {
    throw new Error("ctx.tool.generate_media requires a non-empty prompt");
  }
  const request: GenerateImageRequest = {
    kind: "generate_image",
    request_id: `space-media-${randomUUID()}`,
    slug: requiredEnv(SLUG_ENV),
    prompt: trimmed,
    orientation: options.orientation ?? "square",
  };
  if (ctx.actionInvocationId !== undefined) request.action_invocation_id = ctx.actionInvocationId;
  if (ctx.actionName !== undefined) request.action_name = ctx.actionName;
  if (ctx.rootRequestId !== undefined) request.root_request_id = ctx.rootRequestId;

  const result = await sendGenerate(request, DEFAULT_TIMEOUT_MS);
  const bytes = Buffer.from(result.data_base64, "base64");
  const ext = result.ext && result.ext.length > 0 ? result.ext : "jpg";
  const key = options.key ?? `generated/${randomUUID()}.${ext}`;
  await blobs.put(key, bytes, { contentType: result.content_type });
  const url = await blobs.getUrl(key);
  return {
    blobKey: key,
    url,
    contentType: result.content_type,
    bytes: bytes.length,
  };
}
