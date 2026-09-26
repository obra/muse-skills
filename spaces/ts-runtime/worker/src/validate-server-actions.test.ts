import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";

import {
  REASON_HOST_MODULE_IMPORT,
  REASON_IMPORT_PRIVILEGED_IMPLEMENTATION,
  REASON_PROCESS_GLOBAL,
  analyzeServerActionsShape,
  checkServerActionGraphAsync,
  checkServerActionSource,
} from "./validate-server-actions";

const tempRoots: string[] = [];

afterEach(async () => {
  while (tempRoots.length > 0) {
    const root = tempRoots.pop()!;
    await rm(root, { recursive: true, force: true });
  }
});

async function writeSpace(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "hatch-space-actions-"));
  tempRoots.push(root);
  const serverDir = join(root, "server");
  for (const [path, content] of Object.entries(files)) {
    const file = join(root, path);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, content);
  }
  return serverDir;
}

describe("checkServerActionSource", () => {
  test("rejects process global usage", () => {
    expect(checkServerActionSource("const mode = process.env.NODE_ENV;")).toBe(
      REASON_PROCESS_GLOBAL,
    );
  });
});

describe("checkServerActionGraphAsync", () => {
  test("allows actions importing privileged contracts", async () => {
    const serverDir = await writeSpace({
      "server/src/actions.ts": `
        import { descriptor } from "@space/privileged";
        export const Actions = { descriptor };
      `,
      "server/.generated/privileged.contract.ts": `
        export const descriptor = { name: "demo", input: {}, output: {} };
      `,
    });

    expect(await checkServerActionGraphAsync(serverDir)).toBeNull();
  });

  test("rejects actions importing privileged implementation", async () => {
    const serverDir = await writeSpace({
      "server/src/actions.ts": `
        import { run } from "./privileged";
        export const Actions = { run };
      `,
      "server/src/privileged.ts": `export function run() { return 1; }`,
    });

    expect(await checkServerActionGraphAsync(serverDir)).toEqual(
      expect.objectContaining({
        reason: REASON_IMPORT_PRIVILEGED_IMPLEMENTATION,
      }),
    );
  });

  test("rejects host module imports reachable from actions", async () => {
    const serverDir = await writeSpace({
      "server/src/actions.ts": `
        import { read } from "./helper";
        export const Actions = { read };
      `,
      "server/src/helper.ts": `
        import { readFileSync } from "node:fs";
        export function read() { return readFileSync("/tmp/x", "utf8"); }
      `,
    });

    expect(await checkServerActionGraphAsync(serverDir)).toEqual(
      expect.objectContaining({ reason: REASON_HOST_MODULE_IMPORT }),
    );
  });

  test("allows host modules inside unreachable privileged implementation", async () => {
    const serverDir = await writeSpace({
      "server/src/actions.ts": `export const Actions = {};`,
      "server/src/privileged.ts": `
        import { readFileSync } from "node:fs";
        export const privileged = { readFileSync };
      `,
    });

    expect(await checkServerActionGraphAsync(serverDir)).toBeNull();
  });
});

describe("analyzeServerActionsShape", () => {
  test("treats a module that declares actions as server-backed", () => {
    const src = `
      import { defineAction, z, type ActionsModule } from "@hatch/space-sdk";

      export const Actions = {
        ping: defineAction({
          request: z.object({}),
          response: z.object({ ok: z.boolean() }),
          async handler() { return { ok: true }; },
        }),
      } satisfies ActionsModule;
    `;
    expect(analyzeServerActionsShape(src).clientOnly).toBe(false);
  });
});
