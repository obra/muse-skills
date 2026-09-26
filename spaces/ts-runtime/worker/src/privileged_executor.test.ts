import { describe, expect, test } from "bun:test";

import {
  createPrivilegedExecutor,
  definePrivilegedContracts,
  z,
} from "@hatch/space-sdk";

const privileged = definePrivilegedContracts({
  fetchCalendarEvents: {
    request: z.object({ startMs: z.number(), endMs: z.number() }),
    response: z.object({ events: z.array(z.object({ title: z.string() })) }),
  },
  summarizePrivateNotes: {
    request: z.object({ noteIds: z.array(z.string()) }),
    response: z.object({ summary: z.string() }),
  },
});

describe("createPrivilegedExecutor", () => {
  test("rejects undeclared privileged contracts before dispatch", async () => {
    const executor = createPrivilegedExecutor(
      [privileged.fetchCalendarEvents],
      async () => {
        throw new Error("transport should not run");
      },
    );

    await expect(
      executor.executePrivileged(privileged.summarizePrivateNotes, {
        noteIds: ["n1"],
      }),
    ).rejects.toThrow(
      "ctx.executePrivileged(summarizePrivateNotes) was not declared by this action",
    );
  });

  test("validates request and response schemas at the boundary", async () => {
    const executor = createPrivilegedExecutor(
      [privileged.fetchCalendarEvents],
      async () => ({ events: [{ title: 123 }] }),
    );

    await expect(
      executor.executePrivileged(privileged.fetchCalendarEvents, {
        startMs: 1,
        // Runtime validation still protects JS callers and malformed inputs.
        endMs: "soon",
      } as never),
    ).rejects.toThrow();

    await expect(
      executor.executePrivileged(privileged.fetchCalendarEvents, {
        startMs: 1,
        endMs: 2,
      }),
    ).rejects.toThrow();
  });
});
