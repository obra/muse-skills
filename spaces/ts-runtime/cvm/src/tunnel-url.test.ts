import { test } from "bun:test";
import assert from "node:assert/strict";
import {
  computeSelfBaseDir,
  isExternalUrl,
  isSelfOriginUrl,
  normalizeToRelPath,
  resolveTunnelUrl,
} from "./tunnel-url";

// Core self-origin / external / fail-closed rows only. The fixtures model a
// real CVM document: it loads from an opaque createObjectURL blob URL
// `blob:<origin>/<uuid>` (no path), so its base dir is `blob:<origin>/`.
const HREF = "blob:https://agent.meta.ai/abc-123-uuid";
const BASE = computeSelfBaseDir(HREF); // "blob:https://agent.meta.ai/"
const NO_OBJ: ReadonlySet<string> = new Set();

test("isSelfOriginUrl: absolute URL under our opaque base → true (tunnel it)", () => {
  assert.equal(isSelfOriginUrl("blob:https://agent.meta.ai/actions", BASE, HREF, NO_OBJ), true);
  assert.equal(
    isSelfOriginUrl("blob:https://agent.meta.ai/assets/logo.png", BASE, HREF, NO_OBJ),
    true,
  );
});

test("isSelfOriginUrl: a tracked object URL (real resource) → false", () => {
  const obj = "blob:https://agent.meta.ai/live-object";
  assert.equal(isSelfOriginUrl(obj, BASE, HREF, new Set([obj])), false);
});

test("isSelfOriginUrl: URL outside our base → false", () => {
  assert.equal(isSelfOriginUrl("https://cdn.example.com/x.png", BASE, HREF, NO_OBJ), false);
  assert.equal(isSelfOriginUrl("blob:https://other.host/x", BASE, HREF, NO_OBJ), false);
});

test("isSelfOriginUrl: no base dir → false", () => {
  assert.equal(isSelfOriginUrl("blob:https://agent.meta.ai/actions", "", HREF, NO_OBJ), false);
});

test("isExternalUrl: self-origin and bare-relative refs are internal (false)", () => {
  assert.equal(isExternalUrl("blob:https://agent.meta.ai/actions", BASE, HREF, NO_OBJ), false);
  assert.equal(isExternalUrl("foo/bar.js", BASE, HREF, NO_OBJ), false);
  assert.equal(isExternalUrl("./foo", BASE, HREF, NO_OBJ), false);
  assert.equal(isExternalUrl("/foo", BASE, HREF, NO_OBJ), false);
  assert.equal(isExternalUrl("", BASE, HREF, NO_OBJ), false);
});

test("isExternalUrl: absolute schemes → external", () => {
  for (const u of [
    "https://cdn.example.com/x.png",
    "http://x/y",
    "ws://x",
    "wss://x",
    "mailto:a@b.com",
    "data:image/png;base64,AAAA",
    "about:blank",
    "javascript:void(0)",
    "//cdn.example.com/x.js",
  ]) {
    assert.equal(isExternalUrl(u, BASE, HREF, NO_OBJ), true, u);
  }
});

test("resolveTunnelUrl: SDK `new URL('./actions', location.href)` → tunnelable self URL", () => {
  const out = resolveTunnelUrl("./actions", HREF, HREF, URL);
  assert.equal(out.href, "blob:https://agent.meta.ai/actions");
  // And it round-trips back to the route subpath the daemon serves.
  assert.equal(normalizeToRelPath(out.href, BASE), "actions");
});

test("resolveTunnelUrl: absolute external URL passes through unchanged", () => {
  const out = resolveTunnelUrl("https://cdn.example.com/x.png", undefined, HREF, URL);
  assert.equal(out.href, "https://cdn.example.com/x.png");
  assert.equal(isExternalUrl(out.href, BASE, HREF, NO_OBJ), true);
});

// The ORIGIN-LESS blob shape: a document whose own parent frame is already
// opaque mints `blob:null/<uuid>`, whose inner part is not a URL at all. This
// is the shape a released VM serves, and resolving it against the inner part
// throws `TypeError: Invalid URL` — fatal, because the SDK builds its action
// endpoint with `new URL("./actions", location.href)`, so every server action
// dies on the first call and the artifact renders blank.
const OPAQUE_HREF = "blob:null/704ba01c-24b6-44ca-a147-9544713e7bf2";
const OPAQUE_BASE = computeSelfBaseDir(OPAQUE_HREF); // "blob:null/"

test("computeSelfBaseDir: origin-less blob document", () => {
  assert.equal(OPAQUE_BASE, "blob:null/");
});

test("resolveTunnelUrl: origin-less blob resolves instead of throwing", () => {
  for (const [rel, want] of [
    ["./actions", "blob:null/actions"],
    ["assets/logo.png", "blob:null/assets/logo.png"],
    ["/blobs/k", "blob:null/blobs/k"],
  ] as const) {
    const out = resolveTunnelUrl(rel, OPAQUE_HREF, OPAQUE_HREF, URL);
    assert.equal(out.href, want, rel);
  }
});

test("resolveTunnelUrl: origin-less blob round-trips to the daemon subpath", () => {
  const out = resolveTunnelUrl("./actions", OPAQUE_HREF, OPAQUE_HREF, URL);
  assert.equal(isSelfOriginUrl(out.href, OPAQUE_BASE, OPAQUE_HREF, NO_OBJ), true);
  assert.equal(isExternalUrl(out.href, OPAQUE_BASE, OPAQUE_HREF, NO_OBJ), false);
  assert.equal(normalizeToRelPath(out.href, OPAQUE_BASE), "actions");
});

test("resolveTunnelUrl: origin-less blob keeps external URLs external", () => {
  const out = resolveTunnelUrl("https://cdn.example.com/x.png", OPAQUE_HREF, OPAQUE_HREF, URL);
  assert.equal(out.href, "https://cdn.example.com/x.png");
  assert.equal(isExternalUrl(out.href, OPAQUE_BASE, OPAQUE_HREF, NO_OBJ), true);
});

test("isSelfOriginUrl: a tracked object URL is a real resource on either shape", () => {
  // Both the document and its own object URLs are `blob:null/<uuid>` here, so
  // the tracked-set exclusion is the only thing keeping a genuine resource out
  // of the tunnel.
  const obj = "blob:null/live-object";
  assert.equal(isSelfOriginUrl(obj, OPAQUE_BASE, OPAQUE_HREF, new Set([obj])), false);
  assert.equal(isSelfOriginUrl(obj, OPAQUE_BASE, OPAQUE_HREF, NO_OBJ), true);
});
