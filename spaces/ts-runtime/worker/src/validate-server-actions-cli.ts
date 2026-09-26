#!/usr/bin/env bun

import { join, relative } from "node:path";
import { stat } from "node:fs/promises";

import {
  analyzeServerActionsShape,
  checkServerActionGraphAsync,
} from "./validate-server-actions";

function arg(name: string): string | undefined {
  const flag = `--${name}=`;
  for (const raw of process.argv.slice(2)) {
    if (raw.startsWith(flag)) {
      return raw.slice(flag.length);
    }
  }
  return undefined;
}

const serverDir = arg("server-dir");
if (!serverDir) {
  process.stderr.write("usage: validate-server-actions.js --server-dir=<path>\n");
  process.exit(2);
}

async function main(): Promise<number> {
  try {
    const dirStat = await stat(serverDir!).catch(() => null);
    if (!dirStat || !dirStat.isDirectory()) {
      process.stdout.write(
        JSON.stringify({
          ok: true,
          files: 0,
          clientOnly: true,
          hasServerActions: false,
        }) + "\n",
      );
      return 0;
    }
    const violation = await checkServerActionGraphAsync(serverDir!);
    if (violation !== null) {
      process.stderr.write(
        `${relative(serverDir!, violation.filePath)}: ${violation.reason}\n`,
      );
      return 1;
    }

    // Classify the artifact as client-only (inert, zero-action) or
    // server-backed. The result is daemon-owned downstream: the build pipeline
    // reads it from stdout and persists `has_server_actions`, which gates the
    // local action worker and Cloudflare sharing.
    const actionsSource = await Bun.file(join(serverDir!, "src", "actions.ts"))
      .text()
      .catch(() => "");
    const shape = analyzeServerActionsShape(actionsSource);

    // A client-only artifact has no server surface at all, so it must not ship
    // a privileged implementation. Reject rather than silently ignore it.
    if (shape.clientOnly) {
      const privilegedStat = await stat(
        join(serverDir!, "src", "privileged.ts"),
      ).catch(() => null);
      if (privilegedStat?.isFile()) {
        process.stderr.write(
          "client-only web artifact (no server actions) must not include " +
            "server/src/privileged.ts; remove it, or add a server action to " +
            "make this a server-backed artifact.\n",
        );
        return 1;
      }
    }

    process.stdout.write(
      JSON.stringify({
        ok: true,
        clientOnly: shape.clientOnly,
        hasServerActions: !shape.clientOnly,
      }) + "\n",
    );
    return 0;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`validate-server-actions fatal: ${message}\n`);
    return 2;
  }
}

main().then(
  (code) => process.exit(code),
  (err) => {
    process.stderr.write(`validate-server-actions fatal: ${String(err)}\n`);
    process.exit(2);
  },
);
