import { afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { EXIT_UNSUPPORTED_DOCUMENT } from "./unsupported-document";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture(): Promise<{
  root: string;
  input: string;
  output: string;
  prelude: string;
}> {
  const root = await mkdtemp(path.join(tmpdir(), "hatch-cvm-builder-"));
  roots.push(root);
  const input = path.join(root, "input");
  const output = path.join(root, "output");
  const prelude = path.join(root, "prelude.js");
  await mkdir(path.join(input, "assets"), { recursive: true });
  await writeFile(
    path.join(input, "index.html"),
    '<html><body><script src="./app.js"></script></body></html>',
  );
  await writeFile(path.join(input, "app.js"), 'console.log("client");');
  await writeFile(path.join(input, "assets", "icon.bin"), "asset");
  await writeFile(prelude, "globalThis.__tunnel = {};\n");
  return { root, input, output, prelude };
}

function runBuilder(
  input: string,
  output: string,
  prelude: string,
  rewriteHtmlScripts = false,
) {
  return Bun.spawnSync({
    cmd: [
      process.execPath,
      path.join(import.meta.dir, "build-cvm-client.ts"),
      "--space-dir",
      path.dirname(input),
      "--in",
      input,
      "--out",
      output,
      "--prelude",
      prelude,
      ...(rewriteHtmlScripts ? ["--rewrite-html-scripts"] : []),
    ],
    stdout: "pipe",
    stderr: "pipe",
  });
}

// The exit code is a cross-process contract with the Rust backfill sweep: 65
// means "these bytes will never convert", and the sweep records that against
// the artifact digest and stops retrying so one page cannot hold a VM's
// migration marker open forever. Anything else means "try again later". Losing
// the distinction silently restores the permanent six-hourly retry loop, so
// both directions are pinned.
describe("CVM client build rejection classification", () => {
  test("a document-contract rejection exits EXIT_UNSUPPORTED_DOCUMENT", async () => {
    const { input, output, prelude } = await fixture();
    // eval() is unknowable at build time; no retry of these bytes can succeed.
    await writeFile(
      path.join(input, "index.html"),
      '<html><body><script>eval("1+1")</script></body></html>',
    );

    const result = runBuilder(input, output, prelude, true);
    expect(result.exitCode).toBe(EXIT_UNSUPPORTED_DOCUMENT);
  });

  test("a rejection emits the sentinel the caller requires alongside the code", async () => {
    const { input, output, prelude } = await fixture();
    await writeFile(
      path.join(input, "index.html"),
      '<html><body><script>eval("1+1")</script></body></html>',
    );

    const result = runBuilder(input, output, prelude, true);
    // The Rust side demands BOTH, so a code without the sentinel would be read
    // as an ordinary retryable failure and the rejection would never latch.
    expect(new TextDecoder().decode(result.stderr)).toContain(
      "hatch-cvm-rejected:unsupported-document",
    );
  });

  test("a script the rewriter cannot parse is terminal, not retryable", async () => {
    const { input, output, prelude } = await fixture();
    // The page's own JavaScript does not parse. Deterministic and the author's
    // to fix, so retrying these bytes can only fail again.
    await writeFile(
      path.join(input, "index.html"),
      "<html><body><script>function ( { {</script></body></html>",
    );

    const result = runBuilder(input, output, prelude, true);
    expect(result.exitCode).toBe(EXIT_UNSUPPORTED_DOCUMENT);
  });

  test("a template script containing </body> still gets a live bundle", async () => {
    const { input, output, prelude } = await fixture();
    // The literal text sits inside a preserved non-executable script. Injecting
    // at the first match put the bundle inside the template, which tripped the
    // executable-script count and left the sweep retrying a convertible page
    // every six hours forever.
    await writeFile(
      path.join(input, "index.html"),
      '<html><body><script type="text/template"><div>row</div></body></script><p>hi</p></body></html>',
    );

    const result = runBuilder(input, output, prelude, true);
    expect(result.exitCode).toBe(0);
    const html = await readFile(path.join(output, "index.html"), "utf8");
    const bundleAt = html.indexOf("<script data-hatch-cvm-bundle>");
    expect(bundleAt).toBeGreaterThanOrEqual(0);
    expect(html.slice(0, bundleAt)).toContain("</script>");
  });

  test("a comment containing </body> does not swallow the bundle", async () => {
    const { input, output, prelude } = await fixture();
    // Worse than the template case: this one BUILT, and shipped an artifact
    // whose bundle was commented out, so __tunnel never installed and the page
    // silently rendered untunnelled.
    await writeFile(
      path.join(input, "index.html"),
      "<html><body><!-- closing </body> here --><p>hi</p></body></html>",
    );

    const result = runBuilder(input, output, prelude, true);
    expect(result.exitCode).toBe(0);
    const html = await readFile(path.join(output, "index.html"), "utf8");
    const bundleAt = html.indexOf("<script data-hatch-cvm-bundle>");
    expect(bundleAt).toBeGreaterThanOrEqual(0);
    const before = html.slice(0, bundleAt);
    // Every comment opened before the bundle must also have closed before it.
    expect(before.split("<!--").length).toBe(before.split("-->").length);
  });

  test("a missing staged client stays retryable", async () => {
    const { root, input, output, prelude } = await fixture();
    // Not the author's fault and not deterministic: the canonical build may
    // simply not have run yet, so this must NOT latch as unconvertible.
    await rm(path.join(input, "index.html"));
    expect(existsSync(root)).toBe(true);

    const result = runBuilder(input, output, prelude, true);
    expect(result.exitCode).toBe(1);
  });
});

describe("CVM client build input contract", () => {
  test("excludes persistent standard-build state", async () => {
    const { input, output, prelude } = await fixture();
    for (const directory of [
      "data-workspaces",
      "cloudflare-db-snapshots",
      "cloudflare-blob-snapshots",
      "cloudflare-blob-manifests",
    ]) {
      await mkdir(path.join(input, directory), { recursive: true });
      await writeFile(path.join(input, directory, "private.json"), "private");
    }

    const result = runBuilder(input, output, prelude);
    expect(result.exitCode).toBe(0);
    expect(await readFile(path.join(output, "assets", "icon.bin"), "utf8")).toBe("asset");
    for (const directory of [
      "data-workspaces",
      "cloudflare-db-snapshots",
      "cloudflare-blob-snapshots",
      "cloudflare-blob-manifests",
    ]) {
      expect(existsSync(path.join(output, directory, "private.json"))).toBe(false);
    }
  });

  test("rewrites inline and referenced scripts in document order", async () => {
    const { input, output, prelude } = await fixture();
    await writeFile(
      path.join(input, "index.html"),
      [
        "<html><body>",
        '<script>fetch("./first.json")</script>',
        '<script src="./app.js"></script>',
        '<script type="application/json">{"src":"untouched"}</script>',
        "</body></html>",
      ].join(""),
    );
    await writeFile(path.join(input, "app.js"), 'fetch("./second.json");');

    const result = runBuilder(input, output, prelude, true);
    expect(result.exitCode).toBe(0);
    const html = await readFile(path.join(output, "index.html"), "utf8");
    const bundleIndex = html.indexOf("data-hatch-cvm-bundle");
    const preludeIndex = html.indexOf("globalThis.__tunnel");
    const firstIndex = html.indexOf("first.json");
    const secondIndex = html.indexOf("second.json");
    expect(bundleIndex).toBeGreaterThanOrEqual(0);
    expect(preludeIndex).toBeGreaterThanOrEqual(0);
    expect(firstIndex).toBeGreaterThan(preludeIndex);
    expect(html).toContain("second.json");
    expect(secondIndex).toBeGreaterThan(firstIndex);
    expect(html.match(/__tunnel\.fetch/g)?.length).toBe(2);
    expect(html.match(/<script data-hatch-cvm-bundle/g)?.length).toBe(1);
    expect(html).not.toContain("data-hatch-cvm-prelude");
    expect(html).not.toContain('src="./app.js"');
    expect(html).toContain('<script type="application/json">{"src":"untouched"}</script>');
  });

  test("supports a static artifact with no authored JavaScript", async () => {
    const { input, output, prelude } = await fixture();
    await writeFile(path.join(input, "index.html"), "<html><head></head><body>hello</body></html>");

    const result = runBuilder(input, output, prelude, true);
    expect(result.exitCode).toBe(0);
    const html = await readFile(path.join(output, "index.html"), "utf8");
    expect(html).toContain("data-hatch-cvm-bundle");
    expect(html).toContain("globalThis.__tunnel");
  });

  test("keeps existing inline scripts on the TypeScript bundle path", async () => {
    const { input, output, prelude } = await fixture();
    await writeFile(
      path.join(input, "index.html"),
      [
        "<html><body>",
        '<script>document.documentElement.dataset.theme = "dark";</script>',
        '<script src="./app.js"></script>',
        "</body></html>",
      ].join(""),
    );

    const result = runBuilder(input, output, prelude);
    expect(result.exitCode).toBe(0);
    const html = await readFile(path.join(output, "index.html"), "utf8");
    expect(html).toContain('document.documentElement.dataset.theme = "dark"');
    expect(html).toContain("data-hatch-cvm-bundle");
  });

  test("rejects local module scripts with authoring guidance", async () => {
    const { input, output, prelude } = await fixture();
    await writeFile(
      path.join(input, "index.html"),
      '<html><body><script type="module">console.log("module")</script></body></html>',
    );

    const result = runBuilder(input, output, prelude, true);
    expect(result.exitCode).not.toBe(0);
    expect(new TextDecoder().decode(result.stderr)).toContain(
      'This page cannot use <script type="module"> in private rendering',
    );
    expect(new TextDecoder().decode(result.stderr)).toContain("web_artifacts.exit_build");
  });

  test("preserves external scripts and stylesheets for browser loading", async () => {
    const { input, output, prelude } = await fixture();
    await writeFile(path.join(input, "local.css"), ".local { color: red; }");
    await writeFile(
      path.join(input, "index.html"),
      [
        "<html><head>",
        '<link rel="stylesheet" href="https://cdn.example/library.css">',
        '<link rel="stylesheet" href="./local.css">',
        "</head><body>",
        '<script src="https://cdn.example/library.js" integrity="sha384-value"></script>',
        '<script type="module" src="//cdn.example/module.js"></script>',
        "<script>console.log(window.Library)</script>",
        '<img src="https://cdn.example/image.png">',
        "</body></html>",
      ].join(""),
    );

    const result = runBuilder(input, output, prelude, true);
    expect(result.exitCode).toBe(0);
    const html = await readFile(path.join(output, "index.html"), "utf8");
    expect(html).toContain(
      '<script src="https://cdn.example/library.js" integrity="sha384-value" data-hatch-cvm-external>',
    );
    expect(html).toContain(
      '<script type="module" src="//cdn.example/module.js" data-hatch-cvm-external>',
    );
    expect(html).toContain('<link rel="stylesheet" href="https://cdn.example/library.css">');
    expect(html).not.toContain('<link rel="stylesheet" href="./local.css">');
    expect(html).toContain(".local { color: red; }");
    expect(html).toContain('<img src="https://cdn.example/image.png">');
    expect(html.indexOf("https://cdn.example/library.js")).toBeLessThan(
      html.indexOf("<script data-hatch-cvm-bundle"),
    );
    expect(html).toContain("console.log(window.Library)");
  });

  test("does not trust an authored external-script marker on a local script", async () => {
    const { input, output, prelude } = await fixture();
    await writeFile(
      path.join(input, "index.html"),
      '<html><body><script data-hatch-cvm-external src="./app.js"></script></body></html>',
    );

    const result = runBuilder(input, output, prelude, true);
    expect(result.exitCode).toBe(0);
    const html = await readFile(path.join(output, "index.html"), "utf8");
    expect(html).not.toContain("data-hatch-cvm-external");
    expect(html).not.toContain('src="./app.js"');
    expect(html).toContain('console.log("client")');
  });

  test("does not treat data attributes as src or type", async () => {
    const { input, output, prelude } = await fixture();
    await writeFile(
      path.join(input, "index.html"),
      [
        "<html><body>",
        '<script data-src="./ignored.js" data-type="application/json">fetch("./inline.json")</script>',
        "</body></html>",
      ].join(""),
    );

    const result = runBuilder(input, output, prelude, true);
    expect(result.exitCode).toBe(0);
    const html = await readFile(path.join(output, "index.html"), "utf8");
    expect(html).toContain("inline.json");
    expect(html).toContain("__tunnel.fetch");
  });

  test("reads a start tag whose attribute value contains '>'", async () => {
    // The tokenizer ends a tag at the first `>` OUTSIDE a quoted value, so
    // this is one script the browser runs. Splitting at the inner `>` leaks
    // tag text into the body and fails the build on a valid page.
    const { input, output, prelude } = await fixture();
    await writeFile(
      path.join(input, "index.html"),
      '<html><body><script data-tip="a > b">fetch("./inline.json")</script></body></html>',
    );

    const result = runBuilder(input, output, prelude, true);
    expect(result.exitCode).toBe(0);
    const html = await readFile(path.join(output, "index.html"), "utf8");
    expect(html).toContain("__tunnel.fetch");
    expect(html).toContain("inline.json");
    expect(html.match(/<script data-hatch-cvm-bundle/g)?.length).toBe(1);
  });

  test("recognizes browser-tolerated script closing tags", async () => {
    const { input, output, prelude } = await fixture();
    await writeFile(
      path.join(input, "index.html"),
      [
        "<html><body>",
        '<script>fetch("./one.json")</script >',
        '<script>fetch("./two.json")</script/>',
        '<script>fetch("./three.json")</script ignored>',
        "</body></html>",
      ].join(""),
    );

    const result = runBuilder(input, output, prelude, true);
    expect(result.exitCode).toBe(0);
    const html = await readFile(path.join(output, "index.html"), "utf8");
    expect(html.match(/__tunnel\.fetch/g)?.length).toBe(3);
    expect(html.match(/<script data-hatch-cvm-bundle/g)?.length).toBe(1);
  });

  test("rejects scripts hidden in comments and templates", async () => {
    for (const hiddenScript of [
      '<!-- <script>console.log("comment")</script> -->',
      '<template><script>console.log("template")</script></template>',
    ]) {
      const { input, output, prelude } = await fixture();
      await writeFile(path.join(input, "index.html"), `<html><body>${hiddenScript}</body></html>`);

      const result = runBuilder(input, output, prelude, true);
      expect(result.exitCode).not.toBe(0);
      expect(new TextDecoder().decode(result.stderr)).toContain("Static artifacts do not support");
    }
  });

  test("allows inert HTML and dynamic-evaluation text inside script bodies", async () => {
    const { input, output, prelude } = await fixture();
    await writeFile(
      path.join(input, "index.html"),
      [
        "<html><body>",
        "<script>",
        'const commentMarker = "<!--";',
        'const templateMarker = "<template>";',
        'const evalWarning = "eval() is unsafe";',
        'const functionWarning = "new Function() is unsafe";',
        "// Do not use eval() here.",
        "</script>",
        '<script>const scriptMarker = "<script src=x>";</script>',
        "<script>console.log(commentMarker, templateMarker, evalWarning, functionWarning, scriptMarker)</script>",
        "</body></html>",
      ].join("\n"),
    );

    const result = runBuilder(input, output, prelude, true);
    expect(result.exitCode).toBe(0);
    const html = await readFile(path.join(output, "index.html"), "utf8");
    expect(html).toContain('const commentMarker = "\\x3C!--"');
    expect(html).toContain('const templateMarker = "<template>"');
    expect(html).toContain('const evalWarning = "eval() is unsafe"');
  });

  test("rejects non-inert Function in static scripts with authoring guidance", async () => {
    const { input, output, prelude } = await fixture();
    await writeFile(
      path.join(input, "index.html"),
      '<html><body><script>Function("return fetch(u)")()</script></body></html>',
    );

    const result = runBuilder(input, output, prelude, true);
    const stderr = new TextDecoder().decode(result.stderr);
    expect(result.exitCode).not.toBe(0);
    expect(stderr).toContain("uses dynamic function construction");
    expect(stderr).toContain("Replace dynamic evaluation with ordinary JavaScript");
    expect(stderr).not.toContain("closed-bundle assumption broken");
  });

  test("rejects a residual HTML script-data double-escape sequence", async () => {
    const { input, output, prelude } = await fixture();
    await writeFile(
      path.join(input, "index.html"),
      [
        "<html><body>",
        "<script>const commentMarker = `<!--`;</script>",
        '<script>const scriptMarker = "<script src=x>";</script>',
        "</body></html>",
      ].join("\n"),
    );

    const result = runBuilder(input, output, prelude, true);
    expect(result.exitCode).not.toBe(0);
    expect(new TextDecoder().decode(result.stderr)).toContain(
      "contains an unclosed <!-- before <script",
    );
  });

  test("rewrites the document before injecting authored JavaScript", async () => {
    const { input, output, prelude } = await fixture();
    await writeFile(
      path.join(input, "index.html"),
      [
        "<html><body>",
        "<script>",
        'const image = `<img src="./inside.png">`;',
        'const stylesheet = `<link rel="stylesheet" href="./inside.css">`;',
        "console.log(image, stylesheet);",
        "</script>",
        "</body></html>",
      ].join(""),
    );

    const result = runBuilder(input, output, prelude, true);
    expect(result.exitCode).toBe(0);
    const html = await readFile(path.join(output, "index.html"), "utf8");
    expect(html).toContain("inside.png");
    expect(html).toContain("inside.css");
    expect(html).not.toContain("data-hatch-src");
  });
});
