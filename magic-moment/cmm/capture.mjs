// Card capture worker — runs on the BUNDLE's playwright (the spaces
// ts-runtime ships playwright-core on every VM as bundle contract) against
// the image-baked Chromium. The magic-moment toolkit installs NOTHING for
// this: node, playwright, and the browser all ship with the VM.
//
// stdin: one JSON job:
//   {htmlFile, width, deviceScale, outDir, fps|null}
//   or {url, width, deviceScale, outDir} — a LIVE page screenshot: the
//   browser dials through the cell's egress proxy (https_proxy env), so
//   the capture shows the real site exactly as the runtime saw it.
// Optional on htmlFile jobs:
//   viewportHeight — capture the VIEWPORT at width x viewportHeight
//     instead of the full page (rebuilt browser pages are viewports,
//     not receipts; below-the-fold content is cut like a real browser).
//   measure: ["<css selector>", ...] — also return each selector's
//     first-match box in CSS px as rects: {sel: [x, y, w, h] | null}.
// stdout: one JSON result:
//   {frames: ["f000.png", ...], loopSeconds, rects?}
// A null fps (static card) captures a single frame at t=0.
import { createRequire } from "node:module";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const req = createRequire(import.meta.url);
function loadPlaywright() {
  const roots = [
    process.env.MM_PLAYWRIGHT_MODULES,
    "/opt/hatch/skills/spaces/ts-runtime/dist/node_modules",
  ].filter(Boolean);
  for (const root of roots) {
    try { return req(join(root, "playwright-core")); } catch {}
    try { return req(join(root, "playwright")); } catch {}
  }
  throw new Error(
    "bundled playwright not found (expected under " +
    "/opt/hatch/skills/spaces/ts-runtime/dist/node_modules)");
}

function chromiumBinary() {
  for (const p of [process.env.JARVIS_CHROMIUM_BINARY,
                   "/opt/meta-chromium/chrome"]) {
    if (p && existsSync(p)) return p;
  }
  return null; // dev machines: playwright's own browser store
}

const job = JSON.parse(readFileSync(0, "utf8"));
const { chromium } = loadPlaywright();
// Card (file://) jobs need NO network, so all DNS is blackholed
// outright: without this, Chromium's own phone-home chatter (a CONNECT
// to www.google.com, observed 2026-08-27) leaves the cell, hits
// Sentinel, and mints a user-facing approval mid-render. Live-page
// (url) jobs instead dial ONLY through the cell's egress proxy, which
// keeps Sentinel in the loop for the target site while the
// background-networking kills below still suppress the phone-home
// chatter. The proxy MITMs TLS with a cell CA Chromium's store doesn't
// carry, hence ignore-certificate-errors on url jobs only.
const proxy = process.env.https_proxy || process.env.HTTPS_PROXY || "";
// The cell proxy URL embeds credentials (user:pass@host), which the
// --proxy-server flag cannot express (ERR_NO_SUPPORTED_PROXIES);
// playwright's proxy launch option answers the 407 for us.
let proxyOpt = null;
if (job.url && proxy) {
  try {
    const u = new URL(proxy);
    proxyOpt = { server: `${u.protocol}//${u.host}` };
    if (u.username) {
      proxyOpt.username = decodeURIComponent(u.username);
      proxyOpt.password = decodeURIComponent(u.password || "");
    }
  } catch { proxyOpt = { server: proxy }; }
}
const netArgs = job.url
  ? ["--ignore-certificate-errors"]
  : ["--host-resolver-rules=MAP * ~NOTFOUND", "--proxy-server=direct://"];
const launch = {
  headless: true,
  args: [
    "--disable-gpu", "--no-sandbox", "--disable-dev-shm-usage",
    ...netArgs,
    "--disable-background-networking",
    "--disable-component-update",
    "--disable-sync",
    "--disable-domain-reliability",
  ],
};
if (proxyOpt) launch.proxy = proxyOpt;
const binary = chromiumBinary();
if (binary) {
  launch.executablePath = binary;
  // chrome's own .so files (libGLESv2 etc.) live beside the binary but
  // are not on the default loader path in every exec context.
  const libDir = dirname(binary);
  const prior = process.env.LD_LIBRARY_PATH;
  launch.env = { ...process.env,
                 LD_LIBRARY_PATH: prior ? `${libDir}:${prior}` : libDir };
}

const browser = await chromium.launch(launch);
try {
  const page = await browser.newPage({
    viewport: { width: job.width, height: job.viewportHeight || 900 },
    deviceScaleFactor: job.deviceScale,
    javaScriptEnabled: job.mode === "snapshot",
    serviceWorkers: "block",
  });
  if (job.mode !== "snapshot") {
    await page.route("**/*", route => {
      const protocol = new URL(route.request().url()).protocol;
      return ["file:", "data:"].includes(protocol) ? route.continue() : route.abort();
    });
  }
  const checkBounds = async () => {
    const dims = await page.evaluate(() => ({
      width: document.documentElement.scrollWidth,
      height: document.documentElement.scrollHeight,
    }));
    if (dims.width > job.width || (!job.viewportHeight && dims.height > (job.maxHeight || 2600))) {
      throw new Error(`capture ${dims.width}x${dims.height} exceeds ${job.width}x${job.maxHeight || 2600}; choose an explicit viewport/crop before capture`);
    }
  };
  page.setDefaultTimeout(job.url ? 45000 : 20000);
  if (job.url) {
    // Real sites never reliably reach networkidle; load + a settle
    // beat captures what a user actually sees.
    await page.goto(job.url, { waitUntil: "load" });
    await page.waitForTimeout(2500);
    await checkBounds();
    const buf = await page.screenshot({ fullPage: !job.viewportHeight });
    writeFileSync(join(job.outDir, "f000.png"), buf);
    process.stdout.write(JSON.stringify({ frames: ["f000.png"], loopSeconds: 0 }));
    await browser.close();
    process.exit(0);
  }
  await page.goto("file://" + job.htmlFile, {
    // networkidle is right for the VM's hermetic chromium; branded dev
    // Chromes keep blocked background requests pending forever, so dev
    // machines can override (MM_WAIT_UNTIL=load).
    waitUntil: process.env.MM_WAIT_UNTIL || "networkidle",
  });

  const seek = (t) => page.evaluate((ms) => {
    document.getAnimations({ subtree: true }).forEach((a) => {
      a.pause(); a.currentTime = ms;
    });
  }, t * 1000);

  await page.evaluate(() => document.fonts.ready);
  const shot = async (name) => {
    await checkBounds();
    if (job.mode !== "snapshot") {
      const errors = await page.evaluate(() => {
        const errors = [];
        for (const el of document.body.querySelectorAll("*")) {
          if (![...el.childNodes].some(n => n.nodeType === 3 && n.textContent.trim())) continue;
          const r = el.getBoundingClientRect();
          const cs = getComputedStyle(el);
          if (!r.width || !r.height || cs.visibility === "hidden" || Number(cs.opacity) === 0) continue;
          if (el.checkVisibility && !el.checkVisibility({checkOpacity: true, checkVisibilityCSS: true})) continue;
          if (parseFloat(cs.fontSize) < 32) errors.push(`visible text is ${cs.fontSize}: ${el.textContent.slice(0, 60)}`);
          if (r.right > document.documentElement.clientWidth + 1 || r.left < -1) errors.push(`text overflows horizontally: ${el.textContent.slice(0, 60)}`);
        }
        return errors.slice(0, 5);
      });
      if (errors.length) throw new Error(errors.join("; "));
    }
    const buf = await page.screenshot({
      fullPage: !job.viewportHeight, omitBackground: !job.viewportHeight });
    writeFileSync(join(job.outDir, name), buf);
    return name;
  };

  let rects;
  if (Array.isArray(job.measure) && job.measure.length) {
    rects = await page.evaluate((sels) => {
      const out = {};
      for (const sel of sels) {
        const el = document.querySelector(sel);
        if (!el) { out[sel] = null; continue; }
        const r = el.getBoundingClientRect();
        out[sel] = [r.x, r.y, r.width, r.height];
      }
      return out;
    }, job.measure);
  }

  const timings = await page.evaluate(() => document.getAnimations({ subtree: true }).map(a => {
    const t = a.effect.getComputedTiming();
    return {end: Number.isFinite(t.endTime) ? t.endTime / 1000 : null};
  }));
  const finiteEnd = Math.max(0, ...timings.map(t => t.end || 0));
  const loopSeconds = job.fps ? (job.seconds || finiteEnd) : 0;
  if (job.fps && (loopSeconds > 20 || finiteEnd > loopSeconds + 0.001)) {
    throw new Error(`animation ends at ${finiteEnd}s outside ${loopSeconds}s capture; retime the animation to its beat (maximum 20s)`);
  }
  if (job.fps && timings.some(t => t.end === null) && !job.seconds) {
    throw new Error("looping animation needs the beat's capture seconds");
  }

  const frames = [];
  if (loopSeconds > 0) {
    const count = Math.max(2, Math.ceil(loopSeconds * job.fps) + 1);
    for (let i = 0; i < count; i++) {
      await seek(Math.min(i / job.fps, loopSeconds));
      frames.push(await shot(`f${String(i).padStart(3, "0")}.png`));
    }
  } else {
    await seek(0);
    frames.push(await shot("f000.png"));
  }
  process.stdout.write(JSON.stringify({ frames, loopSeconds, rects }));
} finally {
  await browser.close();
}
