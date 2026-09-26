import { describe, expect, test } from "bun:test";

import { definePrivilegedContracts, z } from "@hatch/space-sdk";

import {
  PRIVILEGED_CONTRACTS_METADATA_FORMAT,
  collectPrivilegedContracts,
  metadataFromContract,
} from "./privileged_contracts";

describe("privileged contract metadata", () => {
  test("collects descriptors from exported contract maps", () => {
    const privileged = definePrivilegedContracts({
      fetchCalendarEvents: {
        request: z.object({ startMs: z.number(), endMs: z.number() }),
        response: z.object({
          events: z.array(z.object({ title: z.string() })),
        }),
        capabilities: ["calendar.read"],
        timeoutMs: 30_000,
      },
      summarizePrivateNotes: {
        request: z.object({ noteIds: z.array(z.string()) }),
        response: z.object({ summary: z.string() }),
      },
    });

    const metadata = collectPrivilegedContracts({ privileged });

    expect(metadata.format).toBe(PRIVILEGED_CONTRACTS_METADATA_FORMAT);
    expect(metadata.contracts.map((contract) => contract.name)).toEqual([
      "fetchCalendarEvents",
      "summarizePrivateNotes",
    ]);
    expect(metadata.contracts[0]).toMatchObject({
      name: "fetchCalendarEvents",
      capabilities: ["calendar.read"],
      timeout_ms: 30_000,
    });
    expect(metadata.contracts[0]?.request_schema).toMatchObject({
      type: "object",
    });
    expect(metadata.contracts[0]?.response_schema).toMatchObject({
      type: "object",
    });
    expect(metadata.contracts[0]?.contract_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  test("contract hash is deterministic for equivalent descriptors", () => {
    const first = definePrivilegedContracts({
      fetchCalendarEvents: {
        request: z.object({ startMs: z.number(), endMs: z.number() }),
        response: z.object({ ok: z.boolean() }),
        capabilities: ["calendar.read"],
        timeoutMs: 30_000,
      },
    });
    const second = definePrivilegedContracts({
      fetchCalendarEvents: {
        request: z.object({ startMs: z.number(), endMs: z.number() }),
        response: z.object({ ok: z.boolean() }),
        capabilities: ["calendar.read"],
        timeoutMs: 30_000,
      },
    });

    expect(metadataFromContract(first.fetchCalendarEvents).contract_hash).toBe(
      metadataFromContract(second.fetchCalendarEvents).contract_hash,
    );
  });

  test("rejects duplicate contract names with different shapes", () => {
    const first = definePrivilegedContracts({
      fetchCalendarEvents: {
        request: z.object({ startMs: z.number() }),
        response: z.object({ ok: z.boolean() }),
      },
    });
    const second = definePrivilegedContracts({
      fetchCalendarEvents: {
        request: z.object({ query: z.string() }),
        response: z.object({ ok: z.boolean() }),
      },
    });

    expect(() =>
      collectPrivilegedContracts({
        first: first.fetchCalendarEvents,
        second: second.fetchCalendarEvents,
      }),
    ).toThrow("duplicate privileged contract name: fetchCalendarEvents");
  });
});
