import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const WEB_AUDIT_MODULE = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "spaces",
  "ts-runtime",
  "dist",
  "playwright-audit.js",
);

export async function loadBrowserAuditRuntime() {
  if (!existsSync(WEB_AUDIT_MODULE)) {
    throw new Error(`shared web artifact audit runtime is missing: ${WEB_AUDIT_MODULE}`);
  }
  const audit = await import(pathToFileURL(WEB_AUDIT_MODULE).href);
  const playwright = await audit.loadPlaywright();
  return {
    audit,
    playwright,
    executablePath: audit.findSystemChrome(),
  };
}
