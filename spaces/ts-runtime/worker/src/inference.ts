// InferenceClient implementation. Talks to the daemon-owned Space inference
// Unix socket using length-prefixed JSON frames. This path intentionally does
// not use the daemon HTTP API and does not shell out to a CLI.

import { randomUUID } from "node:crypto";

import {
  InferenceSchemaError,
  z,
  type InferenceClient,
  type InferenceCompleteOptions,
  type InferenceImageInput,
  type JsonValue,
} from "@hatch/space-sdk";
import { requiredEnv, sendSpaceDaemonRequest } from "./daemon-rpc";

const SOCKET_ENV = "HATCH_SPACE_INFERENCE_SOCKET";
const SLUG_ENV = "HATCH_SPACE_SLUG";
const ACTION_TIMEOUT_MS_ENV = "HATCH_SPACE_ACTION_TIMEOUT_MS";
const DEFAULT_INFERENCE_TIMEOUT_MS_ENV =
  "HATCH_SPACE_INFERENCE_DEFAULT_TIMEOUT_MS";
const MAX_TIMEOUT_SECS = Math.floor(Number.MAX_SAFE_INTEGER / 1000);

type CompleteRequest = {
  kind: "complete";
  request_id: string;
  slug: string;
  prompt: string;
  system?: string;
  json_schema?: JsonValue;
  timeout_secs?: number;
  images?: WireImageInput[];
  action_invocation_id?: string;
  action_name?: string;
  root_request_id?: string;
};

type WireImageInput = {
  mime_type?: string;
  data_base64: string;
  filename?: string;
  caption?: string;
};

type CompleteResult = {
  kind: "complete";
  content: unknown;
  model: string;
  usage?: unknown;
};

type RawResponse =
  | { ok: true; result?: CompleteResult }
  | { ok: false; error?: string; error_code?: string };

type InferenceDeadlineContext = {
  actionDeadlineMs: number;
  defaultServerTimeoutMs: number;
  transportHeadroomMs: number;
};

type InferenceTimeoutPlan = {
  requestTimeoutSecs?: number;
  socketTimeoutMs?: number;
};

function optionalPositiveIntegerEnv(name: string): number | undefined {
  const raw = process.env[name]?.trim();
  if (!raw) return undefined;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(
      `worker environment variable ${name} must be a positive integer`,
    );
  }
  return value;
}

function inferenceDeadlineContextFromEnv():
  | InferenceDeadlineContext
  | undefined {
  const actionTimeoutMs = optionalPositiveIntegerEnv(ACTION_TIMEOUT_MS_ENV);
  const defaultServerTimeoutMs = optionalPositiveIntegerEnv(
    DEFAULT_INFERENCE_TIMEOUT_MS_ENV,
  );
  if (actionTimeoutMs === undefined && defaultServerTimeoutMs === undefined) {
    // Developer probe mode has no enclosing action waiter. The daemon still
    // owns the server deadline, so this client does not install an earlier
    // independent socket timeout.
    return undefined;
  }
  if (
    actionTimeoutMs === undefined ||
    defaultServerTimeoutMs === undefined ||
    defaultServerTimeoutMs >= actionTimeoutMs
  ) {
    throw new Error(
      `${DEFAULT_INFERENCE_TIMEOUT_MS_ENV} must be positive and less than ${ACTION_TIMEOUT_MS_ENV}`,
    );
  }
  return {
    actionDeadlineMs: performance.now() + actionTimeoutMs,
    defaultServerTimeoutMs,
    transportHeadroomMs: actionTimeoutMs - defaultServerTimeoutMs,
  };
}

function validateTimeoutSecs(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    !Number.isSafeInteger(value) ||
    value <= 0 ||
    value > MAX_TIMEOUT_SECS
  ) {
    throw new Error(
      `ctx.inference.complete timeout_secs must be a positive integer no greater than ${MAX_TIMEOUT_SECS}`,
    );
  }
  return value;
}

function timeoutPlan(
  requestedTimeoutSecs: number | undefined,
  deadline: InferenceDeadlineContext | undefined,
): InferenceTimeoutPlan {
  if (deadline === undefined) {
    return requestedTimeoutSecs === undefined
      ? {}
      : { requestTimeoutSecs: requestedTimeoutSecs };
  }

  const actionRemainingMs = Math.max(
    0,
    Math.floor(deadline.actionDeadlineMs - performance.now()),
  );
  const maxServerTimeoutMs = Math.max(
    0,
    actionRemainingMs - deadline.transportHeadroomMs,
  );
  const requestedTimeoutMs =
    requestedTimeoutSecs === undefined
      ? deadline.defaultServerTimeoutMs
      : requestedTimeoutSecs * 1000;

  if (
    requestedTimeoutSecs === undefined &&
    requestedTimeoutMs <= maxServerTimeoutMs
  ) {
    return {
      socketTimeoutMs:
        requestedTimeoutMs + deadline.transportHeadroomMs,
    };
  }

  const effectiveTimeoutSecs = Math.min(
    requestedTimeoutSecs ?? MAX_TIMEOUT_SECS,
    Math.floor(maxServerTimeoutMs / 1000),
  );
  if (effectiveTimeoutSecs <= 0) {
    throw new Error(
      "ctx.inference.complete cannot start because the Space action deadline is too close",
    );
  }
  return {
    requestTimeoutSecs: effectiveTimeoutSecs,
    socketTimeoutMs:
      effectiveTimeoutSecs * 1000 + deadline.transportHeadroomMs,
  };
}

function normalizeImages(
  images: readonly InferenceImageInput[] | undefined,
): WireImageInput[] | undefined {
  if (images === undefined) return undefined;
  if (!Array.isArray(images)) {
    throw new Error("ctx.inference.complete images must be an array");
  }
  const out = images.map((image, index) => {
    if (typeof image !== "object" || image === null) {
      throw new Error(
        `ctx.inference.complete image ${index + 1} must be an object`,
      );
    }
    if (typeof image.dataBase64 !== "string" || image.dataBase64.trim() === "") {
      throw new Error(
        `ctx.inference.complete image ${index + 1} requires non-empty dataBase64`,
      );
    }
    const wire: WireImageInput = {
      data_base64: image.dataBase64,
    };
    if (image.mimeType !== undefined) wire.mime_type = image.mimeType;
    if (image.filename !== undefined) wire.filename = image.filename;
    if (image.caption !== undefined) wire.caption = image.caption;
    return wire;
  });
  return out.length > 0 ? out : undefined;
}

async function sendComplete(
  request: CompleteRequest,
  timeout: number | undefined,
): Promise<CompleteResult> {
  const socketPath = requiredEnv(SOCKET_ENV);
  const raw = (await sendSpaceDaemonRequest(
    socketPath,
    request,
    timeout,
  )) as RawResponse;

  if (raw.ok !== true) {
    throw new Error(raw.error || "web artifact inference failed");
  }
  if (!raw.result || raw.result.kind !== "complete") {
    throw new Error(
      "web artifact inference response did not contain a completion result",
    );
  }
  return raw.result;
}

/**
 * Validate raw inference content against the action's Zod schema and return
 * the typed value. Throws `InferenceSchemaError` when the model response does
 * not satisfy the schema. Exported for unit testing — production callers go
 * through `complete()`.
 */
export function parseInferenceContent<T extends z.ZodType>(
  schema: T,
  content: unknown,
): z.infer<T> {
  const parsed = schema.safeParse(content);
  if (!parsed.success) {
    throw new InferenceSchemaError(parsed.error.issues);
  }
  return parsed.data;
}

/**
 * Convert a Zod schema to the JSON Schema payload the inference daemon expects.
 * Exported for unit testing.
 */
export function schemaToJsonSchema(schema: z.ZodType): JsonValue {
  return z.toJSONSchema(schema, {
    io: "output",
    unrepresentable: "any",
  }) as JsonValue;
}

type InferenceContext = {
  actionInvocationId?: string;
  actionName?: string;
  rootRequestId?: string;
};

async function complete<T extends z.ZodType>(
  prompt: string,
  options: InferenceCompleteOptions<T>,
  ctx?: InferenceContext,
  deadline?: InferenceDeadlineContext,
): Promise<z.infer<T>> {
  if (
    typeof options !== "object" ||
    options === null ||
    options.schema === undefined ||
    options.schema === null
  ) {
    throw new Error(
      "ctx.inference.complete requires a `schema` (a Zod schema) in options",
    );
  }

  const requestedTimeoutSecs = validateTimeoutSecs(options.timeout_secs);
  const plan = timeoutPlan(requestedTimeoutSecs, deadline);
  const jsonSchema = schemaToJsonSchema(options.schema);

  const request: CompleteRequest = {
    kind: "complete",
    request_id: `space-inference-${randomUUID()}`,
    slug: requiredEnv(SLUG_ENV),
    prompt,
    json_schema: jsonSchema,
  };
  if (options.system) request.system = options.system;
  if (plan.requestTimeoutSecs !== undefined) {
    request.timeout_secs = plan.requestTimeoutSecs;
  }
  const images = normalizeImages(options.images);
  if (images) request.images = images;
  if (ctx?.actionInvocationId !== undefined) request.action_invocation_id = ctx.actionInvocationId;
  if (ctx?.actionName !== undefined) request.action_name = ctx.actionName;
  if (ctx?.rootRequestId !== undefined) request.root_request_id = ctx.rootRequestId;

  const result = await sendComplete(request, plan.socketTimeoutMs);
  return parseInferenceContent(options.schema, result.content);
}

export function createInferenceClient(
  actionInvocationId?: string,
  actionName?: string,
  rootRequestId?: string,
): InferenceClient {
  const deadline = inferenceDeadlineContextFromEnv();
  const ctx: InferenceContext = {
    ...(actionInvocationId !== undefined ? { actionInvocationId } : {}),
    ...(actionName !== undefined ? { actionName } : {}),
    ...(rootRequestId !== undefined ? { rootRequestId } : {}),
  };
  return {
    complete: (prompt, options) => complete(prompt, options, ctx, deadline),
  };
}
