// Worker wire protocol.
//
// Commands arrive on stdin as NDJSON; frames are written to FD 3 as NDJSON.
// The daemon-side dispatcher (Rust) is the canonical schema authority — these
// types must stay byte-compatible with what the daemon produces and consumes.

import type { LocalViewer } from "@hatch/space-sdk";

export interface InvokeCommand {
  kind: "invoke";
  action: string;
  args: Record<string, unknown>;
  viewer?: LocalViewer;
  invocation_id: string;
  request_id: string;
  slug: string;
  transport: "request" | "stream";
  // Chat-level (or ingress) trace root for this action, forwarded so ctx.tool /
  // ctx.inference / ctx.agent socket calls inherit the originating request's
  // lineage. Absent when the action has no resolved root.
  root_request_id?: string;
  proxy_env?: Record<string, string>;
}

export interface CancelCommand {
  kind: "cancel";
  request_id: string;
}

export interface ShutdownCommand {
  kind: "shutdown";
}

export type WorkerCommand = InvokeCommand | CancelCommand | ShutdownCommand;

export interface ReadyFrame {
  kind: "ready";
  actions: string[];
  action_metadata?: SpaceActionMetadata[];
}

export interface SpaceActionMetadata {
  name: string;
  request_schema?: Record<string, unknown>;
}

export interface DataFrame {
  kind: "data";
  request_id: string;
  data: unknown;
}

export interface EndFrame {
  kind: "end";
  request_id: string;
}

export interface ErrorFrame {
  kind: "error";
  request_id: string;
  error: string;
}

export interface InvalidateQueriesFrame {
  kind: "invalidate_queries";
  request_id: string;
  query_keys: unknown[][];
}

export type WorkerFrame =
  | ReadyFrame
  | DataFrame
  | EndFrame
  | ErrorFrame
  | InvalidateQueriesFrame;

export function parseCommand(line: string): WorkerCommand {
  const parsed = JSON.parse(line) as Partial<WorkerCommand> & { kind?: string };
  if (!parsed || typeof parsed !== "object" || typeof parsed.kind !== "string") {
    throw new Error("invalid command: missing kind");
  }
  switch (parsed.kind) {
    case "invoke":
      return parsed as InvokeCommand;
    case "cancel":
      return parsed as CancelCommand;
    case "shutdown":
      return parsed as ShutdownCommand;
    default:
      throw new Error(`invalid command kind: ${parsed.kind}`);
  }
}
