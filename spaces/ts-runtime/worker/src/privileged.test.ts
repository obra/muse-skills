import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type Server, type Socket } from "node:net";

import { definePrivilegedContracts, z } from "@hatch/space-sdk";

import { createPrivilegedTransport } from "./privileged";

const tempDirs: string[] = [];
const servers: Server[] = [];
const originalEnv = {
  HATCH_SPACE_PRIVILEGED_SOCKET: process.env.HATCH_SPACE_PRIVILEGED_SOCKET,
  HATCH_SPACE_SLUG: process.env.HATCH_SPACE_SLUG,
};

afterEach(async () => {
  process.env.HATCH_SPACE_PRIVILEGED_SOCKET =
    originalEnv.HATCH_SPACE_PRIVILEGED_SOCKET;
  process.env.HATCH_SPACE_SLUG = originalEnv.HATCH_SPACE_SLUG;
  while (servers.length > 0) {
    const server = servers.pop();
    if (server) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      await rm(dir, { force: true, recursive: true });
    }
  }
});

function encodeFrame(value: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(value), "utf8");
  const frame = Buffer.allocUnsafe(4 + body.length);
  frame.writeUInt32BE(body.length, 0);
  body.copy(frame, 4);
  return frame;
}

function decodeFrame(buffer: Buffer): unknown {
  const len = buffer.readUInt32BE(0);
  return JSON.parse(buffer.subarray(4, 4 + len).toString("utf8"));
}

async function listen(
  handle: (request: unknown) => unknown,
): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "hatch-space-privileged-"));
  tempDirs.push(dir);
  const socketPath = join(dir, "privileged.sock");
  const server = createServer((socket: Socket) => {
    const chunks: Buffer[] = [];
    socket.on("data", (chunk) => {
      chunks.push(Buffer.from(chunk));
      const buffer = Buffer.concat(chunks);
      if (buffer.length < 4) {
        return;
      }
      const len = buffer.readUInt32BE(0);
      if (buffer.length - 4 < len) {
        return;
      }
      socket.end(encodeFrame(handle(decodeFrame(buffer))));
    });
  });
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => {
      server.off("error", reject);
      resolve();
    });
  });
  return socketPath;
}

describe("createPrivilegedTransport", () => {
  test("sends privileged calls over the privileged socket", async () => {
    const privileged = definePrivilegedContracts({
      fetchCalendarEvents: {
        request: z.object({ startMs: z.number(), endMs: z.number() }),
        response: z.object({ events: z.array(z.object({ title: z.string() })) }),
      },
    });
    let received: unknown;
    const socketPath = await listen((request) => {
      received = request;
      return {
        ok: true,
        result: {
          kind: "call",
          result: { events: [{ title: "Planning" }] },
        },
      };
    });
    process.env.HATCH_SPACE_PRIVILEGED_SOCKET = socketPath;
    process.env.HATCH_SPACE_SLUG = "calendar-space";

    const transport = createPrivilegedTransport({
      actionInvocationId: "invocation-1",
      actionName: "refreshCalendar",
      rootRequestId: "root-1",
    });

    await expect(
      transport(privileged.fetchCalendarEvents, { startMs: 1, endMs: 2 }),
    ).resolves.toEqual({ events: [{ title: "Planning" }] });
    expect(received).toMatchObject({
      kind: "call",
      slug: "calendar-space",
      action_name: "refreshCalendar",
      action_invocation_id: "invocation-1",
      contract_name: "fetchCalendarEvents",
      args: { startMs: 1, endMs: 2 },
      root_request_id: "root-1",
    });
  });

  test("surfaces daemon errors", async () => {
    const privileged = definePrivilegedContracts({
      fetchCalendarEvents: {
        request: z.object({}),
        response: z.object({ ok: z.boolean() }),
      },
    });
    const socketPath = await listen(() => ({
      ok: false,
      error: "not enabled",
    }));
    process.env.HATCH_SPACE_PRIVILEGED_SOCKET = socketPath;
    process.env.HATCH_SPACE_SLUG = "calendar-space";

    const transport = createPrivilegedTransport({
      actionInvocationId: "invocation-1",
      actionName: "refreshCalendar",
    });

    await expect(
      transport(privileged.fetchCalendarEvents, {}),
    ).rejects.toThrow("not enabled");
  });
});
