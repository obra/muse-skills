import { createHash } from "node:crypto";

import {
  isPrivilegedContract,
  z,
  type JsonValue,
  type PrivilegedContract,
} from "@hatch/space-sdk";

export const PRIVILEGED_CONTRACTS_METADATA_FORMAT =
  "hatch-space-privileged-contracts-v1" as const;

export interface PrivilegedContractMetadata {
  readonly name: string;
  readonly request_schema: JsonValue;
  readonly response_schema: JsonValue;
  readonly capabilities: readonly string[];
  readonly timeout_ms?: number;
  readonly contract_hash: string;
}

export interface PrivilegedContractsMetadataFile {
  readonly format: typeof PRIVILEGED_CONTRACTS_METADATA_FORMAT;
  readonly contracts: readonly PrivilegedContractMetadata[];
}

function zodToJsonSchema(schema: z.ZodType): JsonValue {
  return z.toJSONSchema(schema, {
    io: "output",
    unrepresentable: "any",
  }) as JsonValue;
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>).sort(
    ([left], [right]) => left.localeCompare(right),
  );
  return `{${entries
    .map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`)
    .join(",")}}`;
}

function contractHash(payload: Omit<PrivilegedContractMetadata, "contract_hash">): string {
  return createHash("sha256")
    .update(stableStringify(payload))
    .digest("hex");
}

export function metadataFromContract(
  contract: PrivilegedContract,
): PrivilegedContractMetadata {
  const metadata = {
    name: contract.name,
    request_schema: zodToJsonSchema(contract.request),
    response_schema: zodToJsonSchema(contract.response),
    capabilities: [...(contract.capabilities ?? [])],
    ...(contract.timeoutMs !== undefined ? { timeout_ms: contract.timeoutMs } : {}),
  };
  return {
    ...metadata,
    contract_hash: contractHash(metadata),
  };
}

export function collectPrivilegedContracts(
  moduleExports: Record<string, unknown>,
): PrivilegedContractsMetadataFile {
  const byName = new Map<string, PrivilegedContractMetadata>();

  function add(candidate: unknown): void {
    if (!isPrivilegedContract(candidate)) {
      return;
    }
    const metadata = metadataFromContract(candidate);
    const existing = byName.get(metadata.name);
    if (existing !== undefined) {
      if (existing.contract_hash === metadata.contract_hash) {
        return;
      }
      throw new Error(`duplicate privileged contract name: ${metadata.name}`);
    }
    byName.set(metadata.name, metadata);
  }

  for (const value of Object.values(moduleExports)) {
    add(value);
    if (typeof value === "object" && value !== null) {
      for (const nested of Object.values(value as Record<string, unknown>)) {
        add(nested);
      }
    }
  }

  return {
    format: PRIVILEGED_CONTRACTS_METADATA_FORMAT,
    contracts: [...byName.values()].sort((left, right) =>
      left.name.localeCompare(right.name),
    ),
  };
}
