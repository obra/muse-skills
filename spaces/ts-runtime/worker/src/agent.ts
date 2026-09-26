// AgentClient implementation for ctx.agent.send().
//
// Talks to the daemon-owned Space inference Unix socket using the same
// length-prefixed JSON frame protocol as ctx.inference.complete. This path
// intentionally does not use the daemon HTTP API and does not shell out to a
// CLI.

import { randomUUID } from "node:crypto";

import type {
  AgentClient,
  AgentSendOptions,
  AgentSendResult,
  AgentStatusResult,
} from "@hatch/space-sdk";
import { requiredEnv, sendSpaceDaemonRequest } from "./daemon-rpc";

interface InvocationContext {
  slug: string;
  invocationId: string;
  action: string;
  rootRequestId?: string;
}

const SOCKET_ENV = "HATCH_SPACE_INFERENCE_SOCKET";
const REQUEST_TIMEOUT_MS = 30_000;

type AgentSendResponse = {
  kind: "agent_send";
  task_id: string;
  agent_id: string;
  message_id: string;
};

type AgentStatusResponse = {
  kind: "agent_status";
  task_id: string;
  status: AgentStatusResult["status"];
  return_contract_status?: AgentStatusResult["returnContractStatus"];
  agent_status?: string;
  agent_id?: string;
  message_id?: string;
  final_response?: string;
  status_message?: string;
  failure_reason?: string;
  expected_action?: string;
  completed_action?: string;
};

function normalizeOptionalText(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

export function createAgentClient(ctx: InvocationContext): AgentClient {
  let nextSpawnRequestOrdinal = 0;

  function nextSpawnRequestId(): string {
    nextSpawnRequestOrdinal += 1;
    return `space-agent-spawn:${ctx.invocationId || "space-action-sdk"}:${nextSpawnRequestOrdinal}`;
  }

  async function spawnTask(
    message: string,
    options?: AgentSendOptions,
  ): Promise<AgentSendResult> {
    if (!ctx.slug) {
      return { ok: false, error: "a web artifact task requires a web artifact slug" };
    }
    if (!message || !message.trim()) {
      return { ok: false, error: "a web artifact task requires a non-empty message" };
    }
    const request = {
      kind: "agent_send",
      request_id: `space-agent-send-${randomUUID()}`,
      slug: ctx.slug,
      action: ctx.action || "action",
      invocation_id: ctx.invocationId || "space-action-sdk",
      spawn_request_id: nextSpawnRequestId(),
      message,
      expected_action: normalizeOptionalText(options?.expectsAction),
      dedupe_key: normalizeOptionalText(options?.dedupeKey),
      ...(options?.allowParallel === true ? { allow_parallel: true } : {}),
      root_request_id: normalizeOptionalText(ctx.rootRequestId),
      workspace_db_path: normalizeOptionalText(process.env.HATCH_SPACE_DB_PATH),
      workspace_blob_dir: normalizeOptionalText(process.env.HATCH_SPACE_BLOB_DIR),
    };
    try {
      const response = await sendSpaceDaemonRequest(
        requiredEnv(SOCKET_ENV),
        request,
        REQUEST_TIMEOUT_MS,
      );
      if (response.ok !== true) {
        return { ok: false, error: response.error || "starting a web artifact task failed" };
      }
      const result = response.result as AgentSendResponse | undefined;
      if (!result || result.kind !== "agent_send") {
        return {
          ok: false,
          error: "starting a web artifact task did not return a task handle",
        };
      }
      return {
        ok: true,
        taskId: result.task_id,
        agentId: result.agent_id,
        messageId: result.message_id,
      };
    } catch (err) {
      return { ok: false, error: String(err) };
    }
  }

  return {
    spawnTask,
    // Deprecated alias; kept so already-built Spaces calling ctx.agent.send
    // keep working. Delegates to the same spawn path as spawnTask.
    send: spawnTask,

    async status(taskId: string): Promise<AgentStatusResult> {
      if (!ctx.slug) {
        return { taskId, status: "not_found" };
      }
      if (!taskId || !taskId.trim()) {
        return { taskId, status: "not_found" };
      }
      const request = {
        kind: "agent_status",
        request_id: `space-agent-status-${randomUUID()}`,
        slug: ctx.slug,
        task_id: taskId,
      };
      const response = await sendSpaceDaemonRequest(
        requiredEnv(SOCKET_ENV),
        request,
        REQUEST_TIMEOUT_MS,
      );
      if (response.ok !== true) {
        throw new Error(response.error || "ctx.agent.status failed");
      }
      const result = response.result as AgentStatusResponse | undefined;
      if (!result || result.kind !== "agent_status") {
        throw new Error("ctx.agent.status response did not contain task status");
      }
      return {
        taskId: result.task_id,
        status: result.status,
        returnContractStatus: result.return_contract_status,
        agentStatus: result.agent_status,
        agentId: result.agent_id,
        messageId: result.message_id,
        finalResponse: result.final_response,
        statusMessage: result.status_message,
        failureReason: result.failure_reason,
        expectedAction: result.expected_action,
        completedAction: result.completed_action,
      };
    },
  };
}
