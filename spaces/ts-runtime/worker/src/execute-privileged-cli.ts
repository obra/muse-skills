#!/usr/bin/env bun

import { pathToFileURL } from "node:url";

import {
  isPrivilegedHandlers,
  type PrivilegedHandlerEntry,
  type PrivilegedHandlers,
} from "../../sdk/src/server-contract";
import { installInvocationFetchProxy, withInvocationProxyEnv } from "./invocation_env";

const PROXY_ENV_KEYS = [
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "http_proxy",
  "https_proxy",
  "all_proxy",
] as const;

type Args = {
  modulePath: string;
  contractName: string;
};

type RunnerResponse =
  | { ok: true; result: unknown }
  | { ok: false; error: string };

function parseArgs(argv: string[]): Args {
  let modulePath = "";
  let contractName = "";
  for (const arg of argv) {
    if (arg.startsWith("--module=")) {
      modulePath = arg.slice("--module=".length);
    } else if (arg.startsWith("--contract=")) {
      contractName = arg.slice("--contract=".length);
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  if (!modulePath) {
    throw new Error("missing --module=<path>");
  }
  if (!contractName) {
    throw new Error("missing --contract=<name>");
  }
  return { modulePath, contractName };
}

async function readStdinJson(): Promise<unknown> {
  const raw = await Bun.stdin.text();
  if (!raw.trim()) {
    return {};
  }
  return JSON.parse(raw);
}

function collectHandlers(moduleExports: Record<string, unknown>): PrivilegedHandlerEntry[] {
  const entries: PrivilegedHandlerEntry[] = [];
  function add(candidate: unknown): void {
    if (isPrivilegedHandlers(candidate)) {
      entries.push(...(candidate as PrivilegedHandlers).entries);
    }
  }
  for (const value of Object.values(moduleExports)) {
    add(value);
    if (typeof value === "object" && value !== null) {
      for (const nested of Object.values(value as Record<string, unknown>)) {
        add(nested);
      }
    }
  }
  return entries;
}

async function execute(): Promise<RunnerResponse> {
  const args = parseArgs(Bun.argv.slice(2));
  const moduleExports = (await import(pathToFileURL(args.modulePath).href)) as Record<
    string,
    unknown
  >;
  const matches = collectHandlers(moduleExports).filter(
    (entry) => entry.contract.name === args.contractName,
  );
  if (matches.length === 0) {
    return {
      ok: false,
      error: `privileged implementation not found: ${args.contractName}`,
    };
  }
  if (matches.length > 1) {
    return {
      ok: false,
      error: `duplicate privileged implementation: ${args.contractName}`,
    };
  }

  const entry = matches[0];
  if (entry === undefined) {
    return {
      ok: false,
      error: `privileged implementation not found: ${args.contractName}`,
    };
  }
  const request = entry.contract.request.parse(await readStdinJson());
  const response = await entry.handler(request);
  return {
    ok: true,
    result: entry.contract.response.parse(response),
  };
}

// The daemon injects the tokenized Sentinel proxy into this process's env. Going
// through it is what lets Sentinel decode the request and match it to the Space's
// grant; dialing TLS directly leaves only an opaque CONNECT, which prompts per
// host. Daemon RPC is unaffected — those calls pass a unix socket, which the
// wrapper leaves alone.
function proxyEnvFromProcess(): Record<string, string> | undefined {
  const proxyEnv: Record<string, string> = {};
  for (const key of PROXY_ENV_KEYS) {
    const value = process.env[key]?.trim();
    if (value) {
      proxyEnv[key] = value;
    }
  }
  return Object.keys(proxyEnv).length > 0 ? proxyEnv : undefined;
}

installInvocationFetchProxy();

withInvocationProxyEnv(proxyEnvFromProcess(), execute)
  .catch((err: unknown): RunnerResponse => {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  })
  .then((response) => {
    process.stdout.write(`${JSON.stringify(response)}\n`);
  });
