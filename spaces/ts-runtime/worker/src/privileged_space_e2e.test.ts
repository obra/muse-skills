import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import {
  createPrivilegedExecutor,
  isAction,
  type BlobClient,
  type Ctx,
  type JsonValue,
  type SpaceDbAccessor,
} from "@hatch/space-sdk";

const tempDirs: string[] = [];

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      await rm(dir, { force: true, recursive: true });
    }
  }
});

function runBun(args: readonly string[], cwd: string): void {
  const result = spawnSync(process.execPath, args, {
    cwd,
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(
      `bun ${args.join(" ")} failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
    );
  }
}

function runBunOutput(args: readonly string[], cwd: string, input?: string): string {
  const result = spawnSync(process.execPath, args, {
    cwd,
    input,
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(
      `bun ${args.join(" ")} failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
    );
  }
  return result.stdout;
}

function unavailableDb(): SpaceDbAccessor {
  return () => {
    throw new Error("test db not available");
  };
}

const unavailableBlobs: BlobClient = {
  async put() {
    throw new Error("test blobs not available");
  },
  async getUrl() {
    throw new Error("test blobs not available");
  },
  async delete() {
    throw new Error("test blobs not available");
  },
  async head() {
    throw new Error("test blobs not available");
  },
  async list() {
    throw new Error("test blobs not available");
  },
};

describe("privileged functions in a bundled Space", () => {
  test("extracts contracts and enforces action declarations during invocation", async () => {
    const spaceDir = await mkdtemp(join(process.cwd(), ".tmp-space-privileged-"));
    tempDirs.push(spaceDir);
    await mkdir(join(spaceDir, "server", "src"), { recursive: true });
    await mkdir(join(spaceDir, "server", "dist"), { recursive: true });
    // Mirror the real scaffold: the `@space/privileged` paths alias lives in
    // `server/tsconfig.json` (relative to server/), NOT a root tsconfig. bun
    // discovers tsconfig from its working directory and (on the pinned 1.3.10)
    // does not walk up from the entrypoint, so actions.ts must be built with
    // cwd=server/ for the alias to apply. Writing a root tsconfig here instead
    // would mask exactly the resolution bug this test guards against.
    await writeFile(
      join(spaceDir, "server", "tsconfig.json"),
      JSON.stringify(
        {
          compilerOptions: {
            module: "Preserve",
            moduleResolution: "bundler",
            paths: {
              "@space/privileged": ["./.generated/privileged.contract"],
            },
          },
        },
        null,
        2,
      ),
      "utf8",
    );

    await writeFile(
      join(spaceDir, "server", "src", "actions.ts"),
      `
        import { defineAction, z, type ActionsModule } from "@hatch/space-sdk";
        import { privileged } from "@space/privileged";

        export const Actions = {
          refreshCalendar: defineAction({
            request: z.object({ startMs: z.number(), endMs: z.number() }),
            response: z.object({ count: z.number(), firstTitle: z.string() }),
            privileged: [privileged.fetchCalendarEvents],
            async handler(ctx, args) {
              const { events } = await ctx.executePrivileged(
                privileged.fetchCalendarEvents,
                args,
              );
              return {
                count: events.length,
                firstTitle: events[0]?.title ?? "",
              };
            },
          }),
        } satisfies ActionsModule;
      `,
      "utf8",
    );
    await writeFile(
      join(spaceDir, "server", "src", "privileged.ts"),
      `
        import { basename } from "node:path";
        import {
          definePrivilegedContracts,
          definePrivilegedHandlers,
          z,
        } from "@hatch/space-sdk";

        export const privileged = definePrivilegedContracts({
          fetchCalendarEvents: {
            request: z.object({ startMs: z.number(), endMs: z.number() }),
            response: z.object({
              events: z.array(z.object({ title: z.string() })),
            }),
            capabilities: ["calendar.read"],
            timeoutMs: 30000,
          },
        });

        export const privilegedHandlers = definePrivilegedHandlers(privileged, {
          fetchCalendarEvents(args) {
            return {
              events: [{
                title: \`Window \${args.startMs}-\${args.endMs}-\${basename("/tmp/report")}\`,
              }],
            };
          },
        });
      `,
      "utf8",
    );
    runBun(
      [
        "src/extract-privileged-contracts-cli.ts",
        `--source=${join(spaceDir, "server", "src", "privileged.ts")}`,
        `--generated-source-out=${join(spaceDir, "server", ".generated", "privileged.contract.ts")}`,
      ],
      process.cwd(),
    );
    const generatedContract = await readFile(
      join(spaceDir, "server", ".generated", "privileged.contract.ts"),
      "utf8",
    );
    expect(generatedContract).toContain("fetchCalendarEvents");
    expect(generatedContract).not.toContain("node:path");
    expect(generatedContract).not.toContain("definePrivilegedHandlers");

    // Build actions.ts from the server/ project dir (as bundle_server does) so
    // bun applies the server/tsconfig.json `@space/privileged` alias.
    runBun(
      [
        "build",
        "./src/actions.ts",
        "--target=bun",
        "--outfile=./dist/actions.js",
      ],
      join(spaceDir, "server"),
    );
    runBun(
      [
        "build",
        "./server/src/privileged.ts",
        "--target=bun",
        "--outfile=./server/dist/privileged.js",
      ],
      spaceDir,
    );
    runBun(
      [
        "build",
        "./server/.generated/privileged.contract.ts",
        "--target=bun",
        "--outfile=./server/dist/privileged-contracts.js",
      ],
      spaceDir,
    );
    runBun(
      [
        "src/extract-privileged-contracts-cli.ts",
        `--module=${join(spaceDir, "server", "dist", "privileged-contracts.js")}`,
        `--out=${join(spaceDir, "server", "dist", "privileged-contracts.json")}`,
      ],
      process.cwd(),
    );

    const metadata = JSON.parse(
      await readFile(
        join(spaceDir, "server", "dist", "privileged-contracts.json"),
        "utf8",
      ),
    ) as { contracts: Array<{ name: string; capabilities: string[] }> };
    expect(metadata.contracts).toHaveLength(1);
    expect(metadata.contracts[0]).toMatchObject({
      name: "fetchCalendarEvents",
      capabilities: ["calendar.read"],
    });

    const privilegedResult = JSON.parse(
      runBunOutput(
        [
          "src/execute-privileged-cli.ts",
          `--module=${join(spaceDir, "server", "dist", "privileged.js")}`,
          "--contract=fetchCalendarEvents",
        ],
        process.cwd(),
        JSON.stringify({ startMs: 1, endMs: 2 }),
      ),
    );
    expect(privilegedResult).toEqual({
      ok: true,
      result: { events: [{ title: "Window 1-2-report" }] },
    });

    const moduleExports = (await import(
      pathToFileURL(join(spaceDir, "server", "dist", "actions.js")).href
    )) as { Actions?: Record<string, unknown> };
    const action = moduleExports.Actions?.refreshCalendar;
    if (!isAction(action)) {
      throw new Error("bundled refreshCalendar action was not branded");
    }

    const privilegedExecutor = createPrivilegedExecutor(
      action.privileged,
      async (contract, args) => {
        expect(contract.name).toBe("fetchCalendarEvents");
        expect(args as { startMs: number; endMs: number }).toEqual({
          startMs: 1,
          endMs: 2,
        });
        return { events: [{ title: "Design review" }] };
      },
    );
    const ctx: Ctx = {
      slug: "privileged-e2e",
      invocationId: "test-invocation",
      spaceDir,
      db: unavailableDb(),
      blobs: unavailableBlobs,
      agent: {
        async spawnTask() {
          return { ok: false, error: "test agent not available" };
        },
        async send() {
          return { ok: false, error: "test agent not available" };
        },
        async status(taskId) {
          return { taskId, status: "not_found" };
        },
      },
      inference: {
        async complete() {
          throw new Error("test inference not available");
        },
      },
      tool: {
        async weather() {
          throw new Error("test tool not available");
        },
        async sports_data() {
          throw new Error("test tool not available");
        },
        async finance() {
          throw new Error("test tool not available");
        },
        async finance_ticker() {
          throw new Error("test tool not available");
        },
        async web_search() {
          throw new Error("test tool not available");
        },
        async generate_media() {
          throw new Error("test tool not available");
        },
      },
      executePrivileged: privilegedExecutor.executePrivileged,
      emit(_data: JsonValue) {},
      invalidateQueries() {},
    };

    await expect(
      action.handler(ctx, { startMs: 1, endMs: 2 }),
    ).resolves.toEqual({
      count: 1,
      firstTitle: "Design review",
    });
  });
});
