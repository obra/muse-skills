// Canonical client bundler for Hatch TS spaces. Owned by the SDK so every
// space produces an identical, production-mode React bundle regardless of
// when it was scaffolded.
//
// Invoked from a space's `client/build.mjs` shim:
//
//   import { buildClient } from "@hatch/space-sdk/build";
//   await buildClient();
//
// Bundles `client/index.html` to `client/dist/`. Asset naming matches the
// daemon's `/spaces/v2/<slug>/assets/*` route. NODE_ENV is forced to
// "production" so React's dev-only paths are tree-shaken out.

import { rm } from "node:fs/promises";
import { basename } from "node:path";
import tailwindPlugin from "bun-plugin-tailwind";

const ENTRY = "./client/index.html";
const OUTDIR = "./client/dist";

export interface BuildClientOptions {
  // Reserved for future per-web-artifact build customization. No fields are
  // supported today; defaults are intentionally locked down to keep
  // production bundles consistent across web artifacts.
}

export async function buildClient(_options: BuildClientOptions = {}): Promise<void> {
  // =============================== STOP ===============================
  // If you are an agent who hit the error below: editing or deleting this
  // guard, or setting HATCH_SPACES_BUILD_DRIVER yourself, is the WRONG fix
  // and leaves a broken, unpublished Space.
  //
  // A web artifact is built, verified, and published ONLY by the
  // artifact create tools and `artifact.edit`, which run the full pipeline
  // (migrations, typecheck, client + server bundle, manifest, icon,
  // screenshot verification, registration, publish) inside a builder
  // subagent. Running the build by hand compiles source but does NOT migrate,
  // verify, register, or deploy anything, so your changes never reach the
  // live web artifact.
  //
  // To change this web artifact, call the `artifact.edit` tool. To make a new
  // one, call `artifact.create_web_static` or `artifact.create_web_fullstack`.
  // ====================================================================
  if (process.env.HATCH_SPACES_BUILD_DRIVER !== "1") {
    console.error(
      "This web artifact cannot be built by hand. To make this change, call the `artifact.edit` tool " +
        "(or `artifact.create_web_static` / `artifact.create_web_fullstack` for a new one); it rebuilds and re-publishes the web artifact " +
        "automatically. Speak to the user as you would about any edit you are " +
        "making for them: conversational, focused on what is changing and that it " +
        "will be ready shortly.",
    );
    process.exit(1);
  }

  if (typeof Bun === "undefined" || typeof Bun.build !== "function") {
    throw new Error("buildClient() must run under Bun");
  }

  await rm(OUTDIR, { force: true, recursive: true });

  const result = await Bun.build({
    entrypoints: [ENTRY],
    outdir: OUTDIR,
    minify: true,
    define: {
      "process.env.NODE_ENV": JSON.stringify("production"),
    },
    naming: {
      asset: "assets/[name]-[hash].[ext]",
      chunk: "assets/[name]-[hash].[ext]",
      entry: "[name].[ext]",
    },
    plugins: [tailwindPlugin],
  });

  if (!result.success) {
    for (const log of result.logs) {
      console.error(log);
    }
    throw new Error("buildClient() failed; see logged diagnostics");
  }

  // Bun writes imported assets to `naming.asset` (`assets/<name>-<hash>.<ext>`)
  // but emits the JS/CSS import URL as a bare `./<name>-<hash>.<ext>` — without
  // the `assets/` directory prefix. The browser then resolves it against the
  // document base (`/spaces/v2/<slug>/`) and requests `/spaces/v2/<slug>/<file>`,
  // which 404s because the daemon only serves built files under `/assets/`.
  // (Bun's `publicPath` would fix asset URLs but double-prefixes the entry/chunk
  // refs, which already carry `assets/` from `naming.chunk`.) Re-prefix only the
  // bare imported-asset URLs to `./assets/...`. This is idempotent
  // (`./assets/<f>` does not contain `./<f>`) and never rewrites chunk refs.
  // Keep `assets/` in sync with `naming.asset` above.
  const assetFiles = result.outputs
    .filter((output) => output.kind === "asset")
    .map((output) => basename(output.path));
  if (assetFiles.length > 0) {
    for (const output of result.outputs) {
      if (!/\.(js|css|html)$/.test(output.path)) {
        continue;
      }
      let text = await output.text();
      let changed = false;
      for (const name of assetFiles) {
        const bare = `./${name}`;
        if (text.includes(bare)) {
          text = text.split(bare).join(`./assets/${name}`);
          changed = true;
        }
      }
      if (changed) {
        await Bun.write(output.path, text);
      }
    }
  }
}
