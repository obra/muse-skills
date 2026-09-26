import { randomUUID } from "node:crypto";

import {
  type PrivilegedContract,
  type PrivilegedRequest,
  type PrivilegedTransport,
} from "@hatch/space-sdk";

import { requiredEnv, sendSpaceDaemonRequest } from "./daemon-rpc";

const SOCKET_ENV = "HATCH_SPACE_PRIVILEGED_SOCKET";
const SLUG_ENV = "HATCH_SPACE_SLUG";
const REQUEST_TIMEOUT_MS = 30_000;

type PrivilegedContext = {
  actionInvocationId: string;
  actionName: string;
  rootRequestId?: string;
};

type PrivilegedCallResponse = {
  kind: "call";
  result: unknown;
};

export function createPrivilegedTransport(ctx: PrivilegedContext): PrivilegedTransport {
  return async function execute<C extends PrivilegedContract>(
    contract: C,
    args: PrivilegedRequest<C>,
  ): Promise<unknown> {
    const request = {
      kind: "call",
      request_id: `space-privileged-${randomUUID()}`,
      slug: requiredEnv(SLUG_ENV),
      action_name: ctx.actionName,
      action_invocation_id: ctx.actionInvocationId,
      contract_name: contract.name,
      args,
      ...(ctx.rootRequestId !== undefined
        ? { root_request_id: ctx.rootRequestId }
        : {}),
    };
    const response = await sendSpaceDaemonRequest(
      requiredEnv(SOCKET_ENV),
      request,
      REQUEST_TIMEOUT_MS,
    );
    if (response.ok !== true) {
      throw new Error(response.error || "web artifact privileged call failed");
    }
    const result = response.result as PrivilegedCallResponse | undefined;
    if (!result || result.kind !== "call") {
      throw new Error("web artifact privileged response did not contain a call result");
    }
    return result.result;
  };
}
