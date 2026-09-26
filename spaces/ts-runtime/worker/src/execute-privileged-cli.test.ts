import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

async function createPrivilegedBundle(source: string): Promise<string> {
  const dir = await mkdtemp(
    join(dirname(process.cwd()), ".tmp-hatch-privileged-exec-"),
  );
  tempDirs.push(dir);
  const sourcePath = join(dir, "privileged.ts");
  const bundlePath = join(dir, "privileged.js");
  await writeFile(sourcePath, source);
  const proc = Bun.spawnSync([
    "bun",
    "build",
    sourcePath,
    "--target=bun",
    "--outfile",
    bundlePath,
  ]);
  expect(proc.exitCode).toBe(0);
  return bundlePath;
}

async function runExecutor(
  modulePath: string,
  contractName: string,
  input: unknown,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn([
    "bun",
    "run",
    "src/execute-privileged-cli.ts",
    `--module=${modulePath}`,
    `--contract=${contractName}`,
  ], {
    cwd: process.cwd(),
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  proc.stdin.write(JSON.stringify(input));
  proc.stdin.end();
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { exitCode, stdout, stderr };
}

describe("execute-privileged CLI", () => {
  test("executes handlers and validates request and response schemas", async () => {
    const bundle = await createPrivilegedBundle(`
      import { definePrivilegedContracts, definePrivilegedHandlers, z } from "../sdk/src/index";

      const privileged = definePrivilegedContracts({
        doubleNumber: {
          request: z.object({ value: z.number() }),
          response: z.object({ doubled: z.number() }),
        },
      });

      export const privilegedHandlers = definePrivilegedHandlers(privileged, {
        doubleNumber(args) {
          return { doubled: args.value * 2 };
        },
      });
    `);

    const result = await runExecutor(bundle, "doubleNumber", { value: 21 });
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toEqual({
      ok: true,
      result: { doubled: 42 },
    });
  });

  test("reports missing handlers as structured errors", async () => {
    const bundle = await createPrivilegedBundle(`
      import { definePrivilegedContracts, definePrivilegedHandlers, z } from "../sdk/src/index";

      const privileged = definePrivilegedContracts({
        known: {
          request: z.object({}),
          response: z.object({ ok: z.boolean() }),
        },
      });

      export const privilegedHandlers = definePrivilegedHandlers(privileged, {
        known() {
          return { ok: true };
        },
      });
    `);

    const result = await runExecutor(bundle, "missing", {});
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      ok: false,
      error: "privileged implementation not found: missing",
    });
  });
});
